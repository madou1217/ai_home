'use strict';

// ZCode 账号出口绑定的领域持久化层。
//
// 背景：客户端会把 code 1005 映射成「今日免费计划额度已用完」，但余额快照并不能
// 解释该拒绝。外部使用经验表明更换出口 IP 可以解除部分同类故障，因此提供账号级
// 出口作为独立的第二层验证/规避手段；这不把 IP 维度冒充成已经证明的唯一根因。
// 本模块只负责记住「账号 → 出口」绑定。文件名保留 zcode 前缀用于兼容既有
// require 路径；provider 范围由生成合同判定，不在这里维护第二份白名单。
//
// 存储沿用 account:usage:<accountRef> 的既有命名惯例，落在 app_kv。
// 本文件只做读写与形状校验，不解析代理、不碰启动流程。

const {
  deleteJsonValue,
  openAppStateDatabase,
  readJsonValue,
  writeJsonValue
} = require('../server/app-state-store');
const {
  isAccountRef,
  resolveAccountRef
} = require('../server/account-ref-store');
const {
  normalizePoolScope,
  POOL_STRATEGIES
} = require('../server/egress-domain-contract');
const { isKnownProvider } = require('../provider-catalog');

const EGRESS_MODE_URL = 'url';
const EGRESS_MODE_SYSTEM = 'system';
const EGRESS_MODE_TUN = 'tun';
// 直连：显式声明「该账号不走任何代理」。它是**一条绑定记录**，而不是「没有绑定」：
//   - 网关请求带 noProxy:'*'，明确绕开服务端全局上游代理（proxy_url）；
//   - CLI 不注入代理变量，桌面端以 --no-proxy-server 启动（zcode 原生 setting.json 的托管代理会被清除）。
// 「未绑定」只表示没有账号级出口，网关仍可能落到服务端全局代理上，所以两者不能互相替代。
const EGRESS_MODE_DIRECT = 'direct';
// 出口池：绑定到 AIH 自己维护的本地出站端口（把用户的代理池节点转成本地 http 代理，
// 见 lib/runtime/egress-pool-*）。与 url 模式的区别是**端口由 AIH 决定**：绑定只记
// 「用池」，实际地址在请求时从进程内单例解析，因此池换端口/换节点都不用重新绑定。
const EGRESS_MODE_POOL = 'pool';
const EGRESS_MODES = new Set([
  EGRESS_MODE_DIRECT,
  EGRESS_MODE_SYSTEM,
  EGRESS_MODE_TUN,
  EGRESS_MODE_URL,
  EGRESS_MODE_POOL
]);
// 已下线的模式：节点/分组都依赖 AIH 自己开的本地代理端口（旧实现）。读到这类历史
// 记录时标记为 retired 交给上层 fail-closed，并保留原字段供 WebUI 提示改绑。
// 注意 `pool` 已**重新启用**（新语义见上），不再属于此集合。
const RETIRED_EGRESS_MODES = new Set(['node', 'group']);

function normalizeAccountRef(accountRef) {
  const value = String(accountRef || '').trim();
  return isAccountRef(value) ? value : '';
}

function buildEgressBindingKey(accountRef) {
  const normalizedRef = normalizeAccountRef(accountRef);
  return normalizedRef ? `account:egress:${normalizedRef}` : '';
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeUpdatedAt(value) {
  const updatedAt = Number(value);
  return Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0;
}

/**
 * 归一化绑定记录。url 模式保留 proxyUrl；切到 system/tun 时也保留它，用户在 WebUI
 * 切换来源时不丢输入。历史 node/group/pool 记录返回 retired 形状（见上）。
 *
 * @param {any} raw
 * @returns {{mode: string, proxyUrl: string, updatedAt: number, retired?: true, nodeId?: string, groupId?: string}|null}
 */
function normalizeEgressBinding(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const proxyUrl = normalizeText(raw.proxyUrl);
  const nodeId = normalizeText(raw.nodeId);
  const groupId = normalizeText(raw.groupId);
  const rawMode = normalizeText(raw.mode).toLowerCase();
  const inferredRetired = !rawMode && !proxyUrl && (nodeId || groupId);
  if (RETIRED_EGRESS_MODES.has(rawMode) || inferredRetired) {
    return {
      mode: rawMode || (nodeId ? 'node' : 'group'),
      retired: true,
      proxyUrl,
      nodeId,
      groupId,
      updatedAt: normalizeUpdatedAt(raw.updatedAt)
    };
  }
  if (rawMode && !EGRESS_MODES.has(rawMode)) return null;
  const mode = rawMode || (proxyUrl ? EGRESS_MODE_URL : '');
  if (!mode) return null;
  if (mode === EGRESS_MODE_URL && !proxyUrl) return null;
  if (mode === EGRESS_MODE_POOL) {
    const poolSelection = normalizePoolSelection(raw);
    if (!poolSelection) return null;
    return { mode, proxyUrl: '', ...poolSelection, updatedAt: normalizeUpdatedAt(raw.updatedAt) };
  }
  return { mode, proxyUrl, updatedAt: normalizeUpdatedAt(raw.updatedAt) };
}

// 出口池绑定的节点选择（docs/plans/2026-10-19-account-egress-upstream-policy.md）：
//   scope.kind  all（内置池：全部节点，默认）| groups（订阅聚合的自建分组，可多选）| nodes（自选节点）
//   strategy    shared（同上游同范围的账号共享轮换）| sticky（账号独占：同上游的账号尽量分到不同出口 IP）
//               | session（会话独占：同一账号的每个本地 CLI 会话各用一个出口，见 egress-pool-session-lease）
// 节点按出口身份（protocol|server|port）记，节点顺序 / 编号变化后选择仍然对得上。
function normalizePoolSelection(raw) {
  try {
    const strategy = normalizeText(raw && raw.strategy).toLowerCase();
    return {
      scope: normalizePoolScope(raw),
      strategy: POOL_STRATEGIES.has(strategy) ? strategy : 'shared'
    };
  } catch (_error) {
    return null;
  }
}

/**
 * @returns {{mode: string, proxyUrl: string, updatedAt: number, retired?: true}|null}
 *   仅在确实没有记录时返回 null；损坏记录必须抛错，让启动链保留现有原生设置。
 */
function readAccountEgressBinding(fs, aiHomeDir, accountRef) {
  const key = buildEgressBindingKey(accountRef);
  if (!key) return null;
  const stored = readJsonValue(fs, aiHomeDir, key, { strict: true });
  if (stored === null) return null;
  const binding = normalizeEgressBinding(stored);
  if (!binding) throw new Error('invalid_account_egress_binding_record');
  return binding;
}

/**
 * 写入绑定；只有 binding 为空时删除该账号的绑定（等价于解绑）。非空非法记录
 * 必须拒绝，不能把调用方错误静默解释为删除。
 *
 * @returns {boolean} true 表示已写入或已删除
 */
function writeAccountEgressBinding(fs, aiHomeDir, accountRef, binding, now = Date.now()) {
  const normalizedRef = normalizeAccountRef(accountRef);
  const account = normalizedRef
    ? resolveAccountRef(fs, aiHomeDir, normalizedRef, { bestEffort: true })
    : null;
  if (!account || !isKnownProvider(account.provider)) {
    throw new Error('invalid_account_egress_account');
  }
  const key = buildEgressBindingKey(normalizedRef);
  if (binding === null || binding === undefined) {
    deleteJsonValue(fs, aiHomeDir, key);
    return true;
  }
  const normalized = normalizeEgressBinding(binding);
  if (!normalized || normalized.retired) throw new Error('invalid_account_egress_binding');
  if (!writeJsonValue(fs, aiHomeDir, key, { ...normalized, updatedAt: now })) {
    throw new Error('account_egress_binding_write_failed');
  }
  return true;
}

/**
 * 所有**仍存在**的账号的出口绑定：[{ accountRef, provider, binding }]（binding 已规范化，含 retired）。
 * 只统计 account_refs 里还在的账号（删号流程不一定清掉绑定记录）。读不到库/没有库时返回 []。
 */
function listAccountEgressBindings(fs, aiHomeDir) {
  let db = null;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, { createIfMissing: false });
    if (!db) return [];
    const rows = db.prepare(`
      SELECT r.account_ref AS accountRef, r.provider AS provider, k.value AS value FROM app_kv k
      JOIN account_refs r ON 'account:egress:' || r.account_ref = k.key
      WHERE k.key LIKE 'account:egress:%'
    `).all();
    return rows.flatMap((row) => {
      try {
        const binding = normalizeEgressBinding(JSON.parse(String(row.value || '')));
        return binding ? [{ accountRef: String(row.accountRef), provider: String(row.provider || ''), binding }] : [];
      } catch (_error) {
        return [];
      }
    });
  } catch (_error) {
    return [];
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_closeError) { /* best effort */ }
    }
  }
}

/**
 * 绑定了出口池（`pool` 模式）且仍存在的账号：[{ accountRef, provider, updatedAt }]。
 * 出口池面板据此展示「哪些账号走池」；server 据此决定启动时要不要拉起内核。
 */
function listEgressPoolBoundAccounts(fs, aiHomeDir) {
  return listAccountEgressBindings(fs, aiHomeDir)
    .filter((entry) => !entry.binding.retired && entry.binding.mode === EGRESS_MODE_POOL)
    .map((entry) => ({ accountRef: entry.accountRef, provider: entry.provider, updatedAt: entry.binding.updatedAt || 0 }));
}

/** 是否有任何仍存在的账号绑定了出口池（server 启动时决定要不要拉起内核）。 */
function hasAnyEgressPoolBinding(fs, aiHomeDir) {
  return listEgressPoolBoundAccounts(fs, aiHomeDir).length > 0;
}

function deleteAccountEgressBinding(fs, aiHomeDir, accountRef) {
  const key = buildEgressBindingKey(accountRef);
  return key ? deleteJsonValue(fs, aiHomeDir, key) : false;
}

module.exports = {
  EGRESS_MODES,
  EGRESS_MODE_DIRECT,
  EGRESS_MODE_POOL,
  EGRESS_MODE_SYSTEM,
  EGRESS_MODE_TUN,
  EGRESS_MODE_URL,
  buildEgressBindingKey,
  deleteAccountEgressBinding,
  hasAnyEgressPoolBinding,
  listAccountEgressBindings,
  listEgressPoolBoundAccounts,
  normalizeEgressBinding,
  readAccountEgressBinding,
  writeAccountEgressBinding
};
