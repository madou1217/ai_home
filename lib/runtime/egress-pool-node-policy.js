'use strict';

// 出口池的**节点拦截策略**：哪些节点不允许被选中出网。
//
// 与账本（egress-pool-node-health）的分工：账本记「事实」（用过几次、失败几次、冷却到什么时候、
// 最近一次探测的延迟），本模块只做**判定**（这些事实 + 用户策略 → 这个节点现在能不能用）。
// 判定是纯函数，存储只有一份（app_kv 的 `egress:node-policy`），这样 WebUI、规划器、轮换三处
// 拿到的结论必然一致。
//
// 三类拦截，各自独立开关（用户要求「延迟阈值」与「连不上」分开做）：
//   1. latency      —— 探测延迟超过阈值（默认 3000ms）的节点；
//   2. unreachable  —— 探测不通（超时 / 拒绝 / 握手失败）的节点；
//   3. manual       —— 用户在界面上手动关掉的节点（按出口身份记，重启/重排后仍然有效）。
//
// 为什么需要（2026-10-21 用户诉求）：账号绑定了出口池后总命中一个 10000ms+ 的节点，请求根本
// 发不出去；这种节点既不会返回 429（所以冷却机制抓不到），又没法自动拉黑。延迟阈值 + 手动关闭
// 这两条路配合，才能把它挡在轮换之外。
//
// 边界（刻意为之）：
//   - 结论跟着**最近一次探测**走，不按时间自动放行：否则一个 10000ms 的节点过几分钟就又能被选中，
//     正是要解决的问题。防止「永久误伤」靠的是重测 —— 被拦截的节点由 dueForProbe 定期重探，
//     延迟恢复正常后自动回到可用集合，不需要用户手动放行；
//   - **从未探测过 ≠ 连不上**：没有探测记录时不拦截（那是「未知」，不是「不可用」）；
//   - 延迟阈值不能超过探测超时（超时的探测拿不到延迟值）：运行时按阈值放宽探测超时，见
//     effectiveProbeTimeoutMs。

const {
  deleteJsonValue,
  readJsonValue,
  writeJsonValue
} = require('../server/app-state-store');

const POLICY_KEY = 'egress:node-policy';
const DEFAULT_LATENCY_MAX_MS = 3000;
const MIN_LATENCY_MAX_MS = 100;
// 上限 = 探测超时能放宽到的最大值：再高的阈值意味着一次探测要等十几秒，拖慢整轮探测。
const MAX_LATENCY_MAX_MS = 15000;
// 探测要比阈值多等一点，才分得清「慢」和「超时」。
const PROBE_TIMEOUT_MARGIN_MS = 1000;
const MAX_DISABLED_NODES = 2000;

const BLOCK_REASONS = Object.freeze({
  latency: 'node_blocked_slow',
  unreachable: 'node_blocked_unreachable',
  manual: 'node_blocked_manual'
});

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeLatencyMaxMs(value) {
  const ms = Math.round(Number(value));
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_LATENCY_MAX_MS;
  return Math.min(MAX_LATENCY_MAX_MS, Math.max(MIN_LATENCY_MAX_MS, ms));
}

/**
 * 策略形状（缺省 = 全部不拦截；存量数据没有这个 key 时也是这个结果）。
 * disabled 是按**出口身份**（协议|服务器|端口）记的，与账本同一口径。
 */
function normalizeNodePolicy(raw) {
  const doc = raw && typeof raw === 'object' ? raw : {};
  const disabled = {};
  const entries = doc.disabled && typeof doc.disabled === 'object' ? Object.entries(doc.disabled) : [];
  entries.slice(0, MAX_DISABLED_NODES).forEach(([identity, entry]) => {
    const key = normalizeString(identity);
    if (!key) return;
    const record = entry && typeof entry === 'object' ? entry : {};
    disabled[key] = {
      at: Number(record.at) || 0,
      label: normalizeString(record.label).slice(0, 120),
      reason: normalizeString(record.reason).slice(0, 200)
    };
  });
  return {
    latency: {
      enabled: normalizeBool(doc.latency && doc.latency.enabled, false),
      maxMs: normalizeLatencyMaxMs(doc.latency && doc.latency.maxMs)
    },
    unreachable: {
      enabled: normalizeBool(doc.unreachable && doc.unreachable.enabled, false)
    },
    disabled,
    updatedAt: Number(doc.updatedAt) || 0
  };
}

function readNodePolicy(fs, aiHomeDir) {
  try {
    return normalizeNodePolicy(readJsonValue(fs, aiHomeDir, POLICY_KEY));
  } catch (_error) {
    return normalizeNodePolicy(null);
  }
}

/** 局部更新：只覆盖传进来的字段（未给的保持原值）。返回规范化后的完整策略。 */
function writeNodePolicy(fs, aiHomeDir, patch, now = Date.now()) {
  const current = readNodePolicy(fs, aiHomeDir);
  const input = patch && typeof patch === 'object' ? patch : {};
  const next = normalizeNodePolicy({
    latency: input.latency === undefined ? current.latency : { ...current.latency, ...input.latency },
    unreachable: input.unreachable === undefined ? current.unreachable : { ...current.unreachable, ...input.unreachable },
    disabled: input.disabled === undefined ? current.disabled : input.disabled,
    updatedAt: now
  });
  next.updatedAt = now;
  if (!writeJsonValue(fs, aiHomeDir, POLICY_KEY, next)) throw new Error('node_policy_write_failed');
  return next;
}

/** 手动关闭 / 放行一个节点（identity = 出口身份）。返回更新后的策略。 */
function setNodeDisabled(fs, aiHomeDir, identity, disabled, meta = {}, now = Date.now()) {
  const key = normalizeString(identity);
  if (!key) throw new Error('invalid_node_identity');
  const current = readNodePolicy(fs, aiHomeDir);
  const nextDisabled = { ...current.disabled };
  if (disabled) {
    nextDisabled[key] = {
      at: now,
      label: normalizeString(meta.label).slice(0, 120),
      reason: normalizeString(meta.reason).slice(0, 200) || 'manual'
    };
    // 超上限时丢最旧的（先关的通常已经没意义了）。
    const keys = Object.keys(nextDisabled);
    if (keys.length > MAX_DISABLED_NODES) {
      keys.sort((a, b) => (nextDisabled[a].at || 0) - (nextDisabled[b].at || 0))
        .slice(0, keys.length - MAX_DISABLED_NODES)
        .forEach((oldest) => { delete nextDisabled[oldest]; });
    }
  } else {
    delete nextDisabled[key];
  }
  return writeNodePolicy(fs, aiHomeDir, { disabled: nextDisabled }, now);
}

function clearDisabledNodes(fs, aiHomeDir, now = Date.now()) {
  const removed = Object.keys(readNodePolicy(fs, aiHomeDir).disabled).length;
  writeNodePolicy(fs, aiHomeDir, { disabled: {} }, now);
  return removed;
}

/**
 * 判定一个节点现在能不能用。纯函数。
 *
 * @param {object} input
 * @param {object} input.policy       normalizeNodePolicy 的结果
 * @param {string} input.identity     出口身份（手动关闭按它匹配）
 * @param {object|null} input.probe   账本里的最近一次探测 { ok, latencyMs, at, error }
 * @returns {{ status: 'allow'|'blocked', reason: string, detail: string }}
 */
function decideNode(input = {}) {
  const policy = input.policy || normalizeNodePolicy(null);
  const identity = normalizeString(input.identity);

  // 手动关闭优先：与探测结果无关，用户说了算。
  if (identity && policy.disabled[identity]) {
    return { status: 'blocked', reason: BLOCK_REASONS.manual, detail: '手动关闭' };
  }

  const probe = input.probe && typeof input.probe === 'object' ? input.probe : null;
  // 从未探测过 = 未知，不是不可用：不拦。
  if (!probe || !probe.at) return { status: 'allow', reason: '', detail: '尚未探测' };

  if (probe.ok !== true) {
    if (!policy.unreachable.enabled) return { status: 'allow', reason: '', detail: '探测不通（未启用拦截）' };
    return {
      status: 'blocked',
      reason: BLOCK_REASONS.unreachable,
      detail: `探测不通${probe.error ? `（${probe.error}）` : ''}`
    };
  }

  const latencyMs = Number(probe.latencyMs) || 0;
  if (policy.latency.enabled && latencyMs > policy.latency.maxMs) {
    return {
      status: 'blocked',
      reason: BLOCK_REASONS.latency,
      detail: `延迟 ${latencyMs}ms 超过阈值 ${policy.latency.maxMs}ms`
    };
  }
  return { status: 'allow', reason: '', detail: latencyMs ? `${latencyMs}ms` : '' };
}

/** 是否被策略挡住（给 pickNext 用的布尔便捷入口）。 */
function isNodeBlocked(input = {}) {
  return decideNode(input).status === 'blocked';
}

/**
 * 探测要等多久：开了延迟阈值时至少比阈值多等 PROBE_TIMEOUT_MARGIN_MS，
 * 否则阈值 8000ms 时一个 6000ms 的节点会被 5000ms 的探测超时判成「连不上」。
 */
function effectiveProbeTimeoutMs(policy, baseTimeoutMs) {
  const base = Number(baseTimeoutMs) > 0 ? Number(baseTimeoutMs) : 5000;
  const normalized = policy || normalizeNodePolicy(null);
  if (!normalized.latency.enabled) return base;
  return Math.max(base, normalized.latency.maxMs + PROBE_TIMEOUT_MARGIN_MS);
}

/** 策略的可读摘要（WebUI 与日志用）。 */
function describeNodePolicy(policy) {
  const normalized = policy || normalizeNodePolicy(null);
  const disabledCount = Object.keys(normalized.disabled).length;
  const parts = [];
  if (normalized.latency.enabled) parts.push(`延迟 > ${normalized.latency.maxMs}ms`);
  if (normalized.unreachable.enabled) parts.push('连不上');
  if (disabledCount) parts.push(`手动关闭 ${disabledCount} 个`);
  return {
    latency: { ...normalized.latency },
    unreachable: { ...normalized.unreachable },
    disabledCount,
    summary: parts.length ? `拦截：${parts.join(' · ')}` : '未启用任何拦截'
  };
}

/** 清空整份策略（恢复为全部不拦截）。 */
function deleteNodePolicy(fs, aiHomeDir) {
  return deleteJsonValue(fs, aiHomeDir, POLICY_KEY);
}

module.exports = {
  BLOCK_REASONS,
  DEFAULT_LATENCY_MAX_MS,
  MAX_LATENCY_MAX_MS,
  MIN_LATENCY_MAX_MS,
  POLICY_KEY,
  PROBE_TIMEOUT_MARGIN_MS,
  clearDisabledNodes,
  decideNode,
  deleteNodePolicy,
  describeNodePolicy,
  effectiveProbeTimeoutMs,
  isNodeBlocked,
  normalizeNodePolicy,
  readNodePolicy,
  setNodeDisabled,
  writeNodePolicy
};
