'use strict';

// 账号列表的**行装配**接线：把 Go 的账号事实同步叠到 Node 的行上。
//
// 为什么是同步取：账号页每次轮询都重新拉列表，若用影子对账那份 60s 缓存，
// 用户点「停用」后页面最多 60s 看不到变化（启停写 Go 是同步的，读却读旧快照）。
// 这里直接走一次本地管理接口（43 行、几毫秒），失败就退回 Node 行并冷却 5 秒，
// 不让 Go 的一次抖动把整个账号页拖慢。
//
// 为什么失败**不**返回 503：装配只覆盖 6 个字段，Node 行本身是完整的。
// 硬 503 会把「Go 抖一下」放大成「账号页打不开」，而页面此刻完全可用。
// 响应里的 goAssembled 标志用于区分「真的由 Go 判定」与「降级到 Node 行」。

const { isDeepStrictEqual } = require('node:util');

const { assembleAccountRow } = require('./account-row-sources');

const DEFAULT_TIMEOUT_MS = 1200;
const FAILURE_COOLDOWN_MS = 5000;
const MAX_PAGES = 10;

// 负缓存只在失败后生效：成功不缓存（否则启停开关会回弹）。
let goUnavailableUntil = 0;

function resetGoAccountRowsState() {
  goUnavailableUntil = 0;
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, status: 0, errorCode: 'go_core_timeout' }), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise).catch(() => ({ ok: false, status: 0, errorCode: 'go_core_unreachable' })), timeout])
    .finally(() => { if (timer) clearTimeout(timer); });
}

// fetchGoAccountRows 拉全量 Go 账号视图（分页）。
// 返回 { ok, rows, errorCode }：ok=false 时调用方必须退回 Node 行。
async function fetchGoAccountRows(goHost, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const now = Date.now();
  if (!goHost || typeof goHost.listManagementAccounts !== 'function') {
    return { ok: false, rows: [], errorCode: 'go_core_unavailable' };
  }
  if (typeof goHost.isEnabled === 'function' && !goHost.isEnabled()) {
    return { ok: false, rows: [], errorCode: 'go_core_disabled' };
  }
  if (now < goUnavailableUntil) {
    return { ok: false, rows: [], errorCode: 'go_core_cooldown' };
  }

  const rows = [];
  let afterRef = '';
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await withTimeout(
      goHost.listManagementAccounts({ limit: 200, afterRef }),
      timeoutMs
    );
    if (!response || response.ok !== true) {
      goUnavailableUntil = Date.now() + FAILURE_COOLDOWN_MS;
      return { ok: false, rows: [], errorCode: (response && response.errorCode) || 'go_core_unavailable' };
    }
    const data = Array.isArray(response.data) ? response.data : [];
    rows.push(...data);
    const next = response.page && response.page.next_after_ref;
    if (!next || data.length === 0) break;
    afterRef = String(next);
  }
  return { ok: true, rows, errorCode: '' };
}

// assembleAccountList 把 Go 行按翻译后的 ref 对齐到 Node 行上。
// 返回 { accounts, matched, changed }：
//   matched —— Go 里有对应账号的行数（Node-only Provider 的账号不在其中）
//   changed —— 装配后真的变了的行数（翻转前应为 0，否则说明两侧结论不一致）
function assembleAccountList(nodeAccounts, goRows, goRefFor) {
  const rows = Array.isArray(nodeAccounts) ? nodeAccounts : [];
  const index = new Map();
  for (const goRow of Array.isArray(goRows) ? goRows : []) {
    const ref = String((goRow && goRow.account_ref) || '').trim();
    if (ref) index.set(ref, goRow);
  }
  let matched = 0;
  let changed = 0;
  const accounts = rows.map((row) => {
    const nodeRef = String((row && row.accountRef) || '').trim();
    const translated = typeof goRefFor === 'function' ? String(goRefFor(nodeRef) || '').trim() : '';
    const goRow = index.get(translated || nodeRef);
    if (!goRow) return row;
    matched += 1;
    const assembled = assembleAccountRow(row, goRow);
    if (!isDeepStrictEqual(assembled, row)) changed += 1;
    return assembled;
  });
  return { accounts, matched, changed };
}

// Go 的 WebUI 读模型：行形状就是账号页契约（accountRef/status/displayName/
// usageSnapshot/modelCount…）。账号页的行来源以它为准 —— Go 决定「有哪些账号」。
const GO_WEBUI_ACCOUNTS_TIMEOUT_MS = 1500;
// 只存在于 Node 的富化字段：Go 读模型不计算运行态、额度原因、zcode 区域与最近使用。
const NODE_ONLY_ROW_FIELDS = Object.freeze([
  'runtimeStatus',
  'runtimeReason',
  'runtimeUntil',
  'quotaReason',
  'lastUsedAt',
  'zcodeRegion'
]);

// fetchGoWebUiAccountRows 拉 Go 的账号页读模型（一次全量，不分页）。
async function fetchGoWebUiAccountRows(goHost, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : GO_WEBUI_ACCOUNTS_TIMEOUT_MS;
  if (!goHost || typeof goHost.listWebUiAccounts !== 'function') {
    return { ok: false, rows: [], errorCode: 'go_core_unavailable' };
  }
  if (typeof goHost.isEnabled === 'function' && !goHost.isEnabled()) {
    return { ok: false, rows: [], errorCode: 'go_core_disabled' };
  }
  if (Date.now() < goUnavailableUntil) {
    return { ok: false, rows: [], errorCode: 'go_core_cooldown' };
  }
  const response = await withTimeout(goHost.listWebUiAccounts(), timeoutMs);
  if (!response || response.ok !== true) {
    const status = Number(response && response.status) || 0;
    if (status === 0 || status >= 500) goUnavailableUntil = Date.now() + FAILURE_COOLDOWN_MS;
    return { ok: false, rows: [], errorCode: (response && response.errorCode) || 'go_core_unavailable' };
  }
  const payload = response.data && typeof response.data === 'object' ? response.data : {};
  const rows = Array.isArray(payload.accounts) ? payload.accounts : [];
  return { ok: true, rows, errorCode: '' };
}

// assembleAccountListFromGoWebUi 以 Go 读模型为行来源，Node 行只提供富化字段。
//
// 账号页以前按 Node 行渲染、再把 Go 的 6 个字段叠上去，于是 Go 独有的账号
// （2026-11-11 的 agy 登录就是这样）永远不出现，影子对账只能报 goOnly=N。
// 现在反过来：Go 有哪些账号就渲染哪些，Node 补运行态/额度原因/zcode 区域/最近使用；
// Go 还不认识的 Node 账号（该 Provider 尚未迁 Go）原样保留，不能因为换来源就藏号。
function assembleAccountListFromGoWebUi(nodeAccounts, goRows, deps = {}) {
  const nodeRows = Array.isArray(nodeAccounts) ? nodeAccounts : [];
  const goRefFor = typeof deps.goAccountRefFor === 'function' ? deps.goAccountRefFor : null;
  const nodeRefFor = deps.goCoreSync && typeof deps.goCoreSync.nodeAccountRefFor === 'function'
    ? deps.goCoreSync.nodeAccountRefFor
    : null;
  const nodeByRef = new Map();
  const nodeByGoRef = new Map();
  for (const row of nodeRows) {
    const ref = String((row && row.accountRef) || '').trim();
    if (!ref) continue;
    nodeByRef.set(ref, row);
    const goRef = String((goRefFor ? goRefFor(ref) : '') || ref).trim();
    if (goRef) nodeByGoRef.set(goRef, row);
  }
  const usedNodeRefs = new Set();
  const accounts = [];
  let changed = 0;
  for (const goRow of Array.isArray(goRows) ? goRows : []) {
    if (!goRow || typeof goRow !== 'object') continue;
    const goRef = String(goRow.accountRef || '').trim();
    if (!goRef) continue;
    const nodeRow = nodeByGoRef.get(goRef) || nodeByRef.get(goRef) || null;
    const row = { ...goRow };
    if (nodeRow) {
      // 行引用回落 Node 键：账号页后续的启停/编辑/删除都按 Node ref 调 Node 路由。
      row.accountRef = nodeRow.accountRef;
      usedNodeRefs.add(nodeRow.accountRef);
      for (const field of NODE_ONLY_ROW_FIELDS) {
        if (nodeRow[field] !== undefined) row[field] = nodeRow[field];
      }
      if (!isDeepStrictEqual(assembleAccountRow(nodeRow, goRow), nodeRow)) changed += 1;
    } else {
      const mapped = String((nodeRefFor ? nodeRefFor(goRef) : '') || '').trim();
      if (mapped) row.accountRef = mapped;
      // Go 独有账号没有 Node 运行态：给中性值，前端不用区分 undefined。
      if (row.runtimeStatus === undefined) row.runtimeStatus = '';
      if (row.runtimeReason === undefined) row.runtimeReason = '';
      if (row.runtimeUntil === undefined) row.runtimeUntil = 0;
      if (row.quotaReason === undefined) row.quotaReason = '';
      if (row.lastUsedAt === undefined) row.lastUsedAt = null;
    }
    accounts.push(row);
  }
  for (const nodeRow of nodeRows) {
    const ref = String((nodeRow && nodeRow.accountRef) || '').trim();
    if (!ref || usedNodeRefs.has(ref)) continue;
    accounts.push(nodeRow);
  }
  return { accounts, matched: usedNodeRefs.size, changed };
}

// assembleAccountListWithGo 是列表/SSE 快照与账号行之间的唯一接线点：
// 首选 Go 读模型（行来源），取不到时退回「Node 行 + Go 事实叠加」的老路径，
// 两条都失败就原样返回 Node 行（goAssembled=false）——Go 抖一下不能让账号页打不开。
async function assembleAccountListWithGo(deps, nodeAccounts) {
  const goHost = deps && deps.goCoreSync;
  if (!goHost) return { accounts: nodeAccounts, goAssembled: false, matched: 0, changed: 0 };
  const webUi = await fetchGoWebUiAccountRows(goHost);
  if (webUi.ok) {
    const result = assembleAccountListFromGoWebUi(nodeAccounts, webUi.rows, deps);
    return { ...result, goAssembled: true };
  }
  const fetched = await fetchGoAccountRows(goHost);
  if (!fetched.ok) return { accounts: nodeAccounts, goAssembled: false, matched: 0, changed: 0 };
  const result = assembleAccountList(nodeAccounts, fetched.rows, deps.goAccountRefFor);
  return { ...result, goAssembled: true };
}

// fetchGoAccountRow 取单个账号的 Go 事实。
//
// 为什么按需取单行而不是缓存列表：watch 的 account 事件是增量，事件时刻的 Node 行
// 可能刚被启停/凭据编辑改过，用一份旧缓存装配会把新值覆盖回去（回弹）。
// 单行接口与列表共用失败冷却，Go 抖动时事件直接沿用 Node 行。
async function fetchGoAccountRow(goHost, nodeRef, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  if (!goHost || typeof goHost.getManagementAccount !== 'function') {
    return { ok: false, row: null, errorCode: 'go_core_unavailable' };
  }
  if (typeof goHost.isEnabled === 'function' && !goHost.isEnabled()) {
    return { ok: false, row: null, errorCode: 'go_core_disabled' };
  }
  if (Date.now() < goUnavailableUntil) {
    return { ok: false, row: null, errorCode: 'go_core_cooldown' };
  }
  const ref = String(nodeRef || '').trim();
  if (!ref) return { ok: false, row: null, errorCode: 'account_ref_missing' };

  const response = await withTimeout(goHost.getManagementAccount(ref), timeoutMs);
  if (!response || response.ok !== true) {
    // 只有传输失败/5xx 才冷却。404 是「这个账号不在 Go」（Node-only Provider 或尚未同步），
    // 属正常降级；若也冷却，一次 gemini 事件会让随后 5s 的列表装配整体退回 Node 行。
    const status = Number(response && response.status) || 0;
    if (status === 0 || status >= 500) {
      goUnavailableUntil = Date.now() + FAILURE_COOLDOWN_MS;
    }
    return { ok: false, row: null, errorCode: (response && response.errorCode) || 'go_core_unavailable' };
  }
  const row = response.data && typeof response.data === 'object' ? response.data : null;
  if (!row) return { ok: false, row: null, errorCode: 'go_account_view_empty' };
  return { ok: true, row, errorCode: '' };
}

// assembleAccountRowWithGo 给**单行**出口（watch 事件、单账号响应）装配 Go 事实。
// 取不到就返回 Node 行，语义与列表降级一致：Go 抖动不让页面回弹或报错。
async function assembleAccountRowWithGo(deps, nodeRow) {
  if (!nodeRow || typeof nodeRow !== 'object') return nodeRow;
  const fetched = await fetchGoAccountRow(deps && deps.goCoreSync, nodeRow.accountRef);
  if (!fetched.ok || !fetched.row) return nodeRow;
  return assembleAccountRow(nodeRow, fetched.row);
}

module.exports = {
  fetchGoAccountRows,
  fetchGoAccountRow,
  fetchGoWebUiAccountRows,
  assembleAccountList,
  assembleAccountListFromGoWebUi,
  assembleAccountListWithGo,
  assembleAccountRowWithGo,
  resetGoAccountRowsState,
  DEFAULT_TIMEOUT_MS,
  FAILURE_COOLDOWN_MS
};
