'use strict';

/**
 * 尝试注解（attempt annotations）：让「本次尝试对上游做了什么改写」自动出现在代理请求日志里。
 *
 * 背景：`appendProxyRequestLog` 的每个调用点都**手写字段表**，于是每新增一个诊断维度都要回到
 * 所有调用点补一行；漏补就变成「代码里记了、日志里查不到」——历史教训是
 * `codebuddyFamilyInjectedSystemPrompt` 只在 attempt 上记录、从未进过任何日志行。
 *
 * 机制：改写产生方只往 `attempt.annotations` 这个袋子里写（`annotateAttempt`），
 * 日志出口统一用 `withAttemptAnnotations(entry, attempt)` 把袋子整体并进条目。
 * 因此**新增一个注解只需改产生它的地方**，所有日志出口（成功、失败、重试失败、下游取消）
 * 自动带上，不需要再改调用点。
 *
 * 约定：
 *   - 注解键必须带命名空间（`codebuddyFamily*`、`geminiCodeAssist*` 之类），便于按前缀检索；
 *   - `false` / `null` / `undefined` / 空串视为「这件事没发生」，不写进日志（否则每行都是噪音）；
 *   - 日志条目的身份字段不可被注解覆盖（见 RESERVED_LOG_KEYS），避免一次笔误让日志认不出自己。
 */

/** 日志条目的身份字段：注解不得覆盖。 */
const RESERVED_LOG_KEYS = Object.freeze(new Set([
  'at',
  'kind',
  'requestId',
  'route',
  'provider',
  'account',
  'accountRef',
  'status',
  'upstreamStatus',
  'streamRequested',
  'durationMs',
  'error',
  'policyKind'
]));

/**
 * 往 attempt 的注解袋子里记一条。返回 attempt 本身，便于链式调用。
 * 值等于 `false` / `null` / `undefined` / 空串时什么都不做（= 该改写没发生）。
 */
function annotateAttempt(attempt, key, value) {
  if (!attempt || typeof attempt !== 'object') return attempt;
  const name = typeof key === 'string' ? key.trim() : '';
  if (!name || RESERVED_LOG_KEYS.has(name)) return attempt;
  if (value === undefined || value === null || value === false || value === '') return attempt;
  if (!attempt.annotations || typeof attempt.annotations !== 'object' || Array.isArray(attempt.annotations)) {
    attempt.annotations = {};
  }
  attempt.annotations[name] = value;
  return attempt;
}

/** 取 attempt 上已有的注解（没有就返回 null）。 */
function attemptAnnotations(attempt) {
  const bag = attempt && attempt.annotations;
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return null;
  const entries = Object.entries(bag).filter(([, value]) => value !== undefined && value !== null);
  if (!entries.length) return null;
  return Object.fromEntries(entries);
}

/** 把注解对象直接并进日志条目（给不持有 attempt 的出口用，例如 diagnostic-log 的 input.annotations）。 */
function withAnnotations(entry, annotations) {
  if (!annotations || typeof annotations !== 'object' || Array.isArray(annotations)) return entry;
  const entries = Object.entries(annotations).filter(([key, value]) => (
    value !== undefined && value !== null && !RESERVED_LOG_KEYS.has(key)
  ));
  if (!entries.length) return entry;
  return { ...entry, ...Object.fromEntries(entries) };
}

/** 把 attempt 的注解并进日志条目（不改动入参对象；没有注解时原样返回）。 */
function withAttemptAnnotations(entry, attempt) {
  return withAnnotations(entry, attemptAnnotations(attempt));
}

module.exports = {
  RESERVED_LOG_KEYS,
  annotateAttempt,
  attemptAnnotations,
  withAnnotations,
  withAttemptAnnotations
};
