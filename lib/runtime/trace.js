'use strict';

/**
 * 唯一的调试开关（`AIH_TRACE`）——替代历史上 10 个零散 debug 环境变量。
 *
 * 取值：
 *   AIH_TRACE=1 / true / *        全开
 *   AIH_TRACE=agy-warm,model-chain  只开列出的 scope
 *   （未设置 / 0 / false）          全关
 *
 * 调试输出**一律写 stderr**：`aih <cli> -p` 的 stdout 是模型答案，不能被日志污染。
 */
function parseTraceScopes(env = process.env) {
  const raw = String((env && env.AIH_TRACE) || '').trim();
  if (!raw || raw === '0' || raw.toLowerCase() === 'false') return new Set();
  if (raw === '1' || raw.toLowerCase() === 'true' || raw === '*') return new Set(['*']);
  return new Set(raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

function isTraceEnabled(env, scope) {
  const scopes = parseTraceScopes(env || process.env);
  if (scopes.size === 0) return false;
  if (scopes.has('*')) return true;
  return scopes.has(String(scope || '').trim().toLowerCase());
}

function traceLog(env, scope, ...args) {
  if (!isTraceEnabled(env, scope)) return false;
  // eslint-disable-next-line no-console
  console.error(`[trace:${scope}]`, ...args);
  return true;
}

module.exports = {
  parseTraceScopes,
  isTraceEnabled,
  traceLog
};
