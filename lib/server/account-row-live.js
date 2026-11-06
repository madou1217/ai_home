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

// assembleAccountListWithGo 是列表响应与 Go 事实之间的唯一接线点：
// 取 Go 事实 → 按 ref 对齐 → 装配。取不到就原样返回 Node 行（goAssembled=false）。
async function assembleAccountListWithGo(deps, nodeAccounts) {
  const goHost = deps && deps.goCoreSync;
  if (!goHost) return { accounts: nodeAccounts, goAssembled: false, matched: 0, changed: 0 };
  const fetched = await fetchGoAccountRows(goHost);
  if (!fetched.ok) return { accounts: nodeAccounts, goAssembled: false, matched: 0, changed: 0 };
  const result = assembleAccountList(nodeAccounts, fetched.rows, deps.goAccountRefFor);
  return { ...result, goAssembled: true };
}

module.exports = {
  fetchGoAccountRows,
  assembleAccountList,
  assembleAccountListWithGo,
  resetGoAccountRowsState,
  DEFAULT_TIMEOUT_MS,
  FAILURE_COOLDOWN_MS
};
