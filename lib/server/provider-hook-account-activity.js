'use strict';

// provider 官方 hook → 账号活动的桥。
//
// 解决的问题：原生 CLI 会话（`aih claude 9`、WebUI 原生会话）直连上游，不经过
// 网关的 attempt 编排，所以 accountActivity 里没有它们的 in-flight——WebUI 账号
// 列表里 logo 不转、剩余额度不燃烧，而「伤害数字」照常出现（那条来自 tokenUsage
// 快照 diff，与本模块无关）。这里把会话回合事件补成第二条活跃来源。
//
// 两个必须守住的点：
// 1) 不用 begin/end 计数。hook 投递有损（进程被杀、发送超时），漏一个结束事件
//    就会永久泄漏成「一直在转圈」，比不亮更糟。改用 markSessionTurn + TTL。
// 2) SubagentStop / TaskCompleted 归一后同样是 turn-completed，但它们发生在主
//    回合仍在跑的时候。按事件名把这些从属结束事件降级成「回合仍在继续」，否则
//    一个子代理跑完就会把主回合的活跃状态熄灭。

const { normalizeProviderAccountRef } = require('../runtime/provider-session-context');

// 归一后是 turn-completed / turn-failed，但语义上只是回合内的一小段结束。
const SUBORDINATE_COMPLETION_EVENTS = new Set([
  'SubagentStop',
  'TaskCompleted',
  'AfterTool',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'PostInvocation'
]);

const TURN_ALIVE_EVENT_TYPES = new Set([
  'session:turn-started',
  'session:turn-updated'
]);

const TURN_DONE_EVENT_TYPES = new Set([
  'session:turn-completed',
  'session:turn-failed',
  'session:closed'
]);

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * 单个 hook 事件对账号活跃状态的影响。纯决策，不碰 I/O，便于单测。
 * 返回 'alive' | 'done' | null（null = 与活跃状态无关，例如 session:opened）。
 */
function resolveSessionTurnAction(eventType, eventName) {
  const type = normalizeText(eventType);
  const name = normalizeText(eventName);
  if (TURN_ALIVE_EVENT_TYPES.has(type)) return 'alive';
  if (!TURN_DONE_EVENT_TYPES.has(type)) return null;
  // 会话关闭是硬结束，任何从属事件名都不该把它降级。
  if (type !== 'session:closed' && SUBORDINATE_COMPLETION_EVENTS.has(name)) return 'alive';
  return 'done';
}

/**
 * 把一条已归一的 hook 事件应用到 accountActivity 上。
 * accountRef 由会话启动时注入的 AIH_PROVIDER_ACCOUNT_REF 随 hook 一起回传
 * （见 provider-runtime-env.js / provider-session-hook-sender.js）；拿不到就
 * 无法归属账号，直接跳过，不做磁盘解析——turn-updated 频率很高，这条路径必须便宜。
 */
function applyProviderHookAccountActivity({
  accountActivity,
  provider,
  accountRef,
  eventType,
  eventName
} = {}) {
  if (!accountActivity) return false;
  const normalizedProvider = normalizeText(provider).toLowerCase();
  const normalizedRef = normalizeProviderAccountRef(accountRef);
  if (!normalizedProvider || !normalizedRef) return false;

  const action = resolveSessionTurnAction(eventType, eventName);
  if (action === 'alive') {
    if (typeof accountActivity.markSessionTurn !== 'function') return false;
    accountActivity.markSessionTurn(normalizedProvider, normalizedRef);
    return true;
  }
  if (action === 'done') {
    if (typeof accountActivity.endSessionTurn !== 'function') return false;
    accountActivity.endSessionTurn(normalizedProvider, normalizedRef);
    return true;
  }
  return false;
}

/**
 * 单个 hook 事件对账号结果桶（健康统计）的影响。纯决策，不碰 I/O。
 *
 * 原生 CLI 会话不经网关 attempt 编排，因此它既没有 in-flight 计数，也没有
 * 上游状态码——回合终态是唯一可观测的结果证据：
 *   * turn-completed（非从属事件）→ success：这一回合真的产出了回答；
 *   * turn-failed → unclassified：Go 的 FailureKind 闭集里没有「CLI 回合失败」这一类，
 *     按「其他」记，绝不假装是限流/超时之类的具体上游分类；
 *   * 从属结束事件（SubagentStop / TaskComplete 等）→ null：主回合还在跑，不算结果；
 *   * session:closed / 开场事件 → null：不是回合结果。
 */
function resolveSessionTurnOutcome(eventType, eventName) {
  const type = normalizeText(eventType);
  const name = normalizeText(eventName);
  if (!TURN_DONE_EVENT_TYPES.has(type)) return null;
  if (type === 'session:closed') return null;
  if (SUBORDINATE_COMPLETION_EVENTS.has(name)) return null;
  return type === 'session:turn-failed' ? 'unclassified' : 'success';
}

/**
 * 把回合结果写进账号结果时间桶（nodeAccountOutcomes）。
 * accountRef 必须已经是 aih 账号（acct_*），否则无法归属，直接跳过。
 */
function applyProviderHookAccountOutcome({
  nodeAccountOutcomes,
  provider,
  accountRef,
  eventType,
  eventName,
  atMs
} = {}) {
  if (!nodeAccountOutcomes || typeof nodeAccountOutcomes.record !== 'function') return false;
  const normalizedProvider = normalizeText(provider).toLowerCase();
  const normalizedRef = normalizeProviderAccountRef(accountRef);
  if (!normalizedProvider || !normalizedRef) return false;
  const outcome = resolveSessionTurnOutcome(eventType, eventName);
  if (!outcome) return false;
  const at = Number(atMs);
  nodeAccountOutcomes.record({
    accountRef: normalizedRef,
    outcome,
    atMs: Number.isFinite(at) && at > 0 ? at : Date.now()
  });
  return true;
}

module.exports = {
  applyProviderHookAccountActivity,
  applyProviderHookAccountOutcome,
  resolveSessionTurnAction,
  resolveSessionTurnOutcome,
  SUBORDINATE_COMPLETION_EVENTS
};
