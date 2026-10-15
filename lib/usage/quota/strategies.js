'use strict';

// 额度策略链执行器：**默认用最稳的策略（不依赖本机客户端的排前面），不可用就切换下一条**。
//
// 策略来自 provider 自己的描述符（`lib/providers/defs/<id>.js` 的 quota.strategies），
// 排序由注册表保证（clientDependent=false 优先，组内保持声明顺序）。
//
// 每次尝试都记进 attempts（strategyId / error / auth），因此「切换过、为什么切换」是可观察的：
// 调用方把它写进探针错误或快照 coverage，不会出现「静默换了一条路」。
//
// 两类策略实现：
//   * probe —— 自包含探针（plugin / 探针工厂），`(deps) => { probe(accountRef, timeoutMs) }`；
//   * handler —— 原生实现由组合根注入（codex/claude/agy/gemini 的既有刷新阶梯），
//     描述符只声明用哪个 handler。

// 直接依赖注册表（不 require ./index，避免 index <-> strategies 循环依赖）。
const { getProviderRegistry } = require('../../providers');

function normalizeError(value) {
  return String(value === undefined || value === null ? '' : value).slice(0, 160);
}

/**
 * @param {string} provider
 * @param {string} accountRef
 * @param {{deps?: object, timeoutMs?: number, handlers?: object, strategyId?: string, options?: object}} ctx
 * @returns {Promise<{snapshot?: object, strategyId?: string, attempts: Array<object>, error?: string, auth?: boolean}>}
 */
async function runQuotaStrategies(provider, accountRef, ctx = {}) {
  const strategies = getProviderRegistry(ctx.options || {}).listQuotaStrategies(provider);
  const attempts = [];
  if (strategies.length === 0) return { attempts, error: 'no_quota_strategy' };
  for (const strategy of strategies) {
    if (ctx.strategyId && strategy.id !== ctx.strategyId) continue;
    try {
      if (strategy.handler) {
        const handler = ctx.handlers && ctx.handlers[strategy.handler];
        if (typeof handler !== 'function') {
          attempts.push({ strategyId: strategy.id, error: 'handler_unavailable' });
          continue;
        }
        const snapshot = await handler(strategy, { accountRef, timeoutMs: ctx.timeoutMs, deps: ctx.deps });
        if (snapshot) return { snapshot, strategyId: strategy.id, attempts };
        attempts.push({ strategyId: strategy.id, error: 'no_snapshot' });
        continue;
      }
      const probe = strategy.probe(ctx.deps || {});
      if (!probe || typeof probe.probe !== 'function') {
        attempts.push({ strategyId: strategy.id, error: 'probe_factory_invalid' });
        continue;
      }
      const result = await probe.probe(accountRef, ctx.timeoutMs);
      if (result && result.snapshot) return { snapshot: result.snapshot, strategyId: strategy.id, attempts };
      // 「额度不适用」是**结论**，不是失败：来源明确回答「这个账号没有可消耗的额度池」
      // （例如 qoder Free 档 credits=0）。它不需要再切下一条策略，也不能被当成探测错误——
      // 否则界面会显示「探测失败」并把账号的额度状态判成异常。
      if (result && result.notApplicable === true) {
        const reason = normalizeError(result.reason) || 'not_applicable';
        attempts.push({ strategyId: strategy.id, notApplicable: true, error: reason });
        return { notApplicable: true, reason, strategyId: strategy.id, attempts };
      }
      attempts.push({
        strategyId: strategy.id,
        error: normalizeError(result && result.error) || 'no_snapshot',
        auth: Boolean(result && result.auth)
      });
    } catch (error) {
      attempts.push({
        strategyId: strategy.id,
        error: `probe_exception:${normalizeError(error && error.message || error)}`
      });
    }
  }
  const last = attempts[attempts.length - 1] || {};
  return {
    attempts,
    error: last.error || 'no_strategy_available',
    auth: attempts.some((attempt) => attempt.auth)
  };
}

/** 把 attempts 折成一行可读原因（写进探针错误/快照 coverage 时用）。 */
function summarizeStrategyAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return '';
  return attempts.map((attempt) => `${attempt.strategyId}:${attempt.error}`).join(' | ');
}

module.exports = {
  runQuotaStrategies,
  summarizeStrategyAttempts
};
