'use strict';

// 模型发现的**策略链**（与额度策略链同一套约定：provider 描述符声明、注册表驱动、
// clientDependent=false 优先、失败自动切下一条、attempts 可观察）。
//
// 为什么需要它：模型清单以前只有一条路 —— 跑本地 CLI（`native_cli_model_discovery_*`），
// CLI 不在就整个账号「无可用模型」。provider 自己声明 HTTP 策略后，**不装 CLI 也能列出模型**，
// CLI 只是兜底（例如厂商没有可直连的模型接口时）。

const { getProviderCapability } = require('../providers');

function normalizeError(value) {
  return String(value === undefined || value === null ? '' : value).slice(0, 160);
}

/**
 * 依次尝试该 provider 声明的模型发现策略（描述符 `models.strategies`，按注册表排序）。
 *
 * @returns {Promise<{models: string[]|null, strategyId: string, attempts: Array<object>, error: string}>}
 */
async function runProviderModelStrategies(provider, account, ctx = {}) {
  const capability = getProviderCapability(provider, 'models', ctx.options || {});
  const strategies = capability && capability.supported === true && Array.isArray(capability.strategies)
    ? capability.strategies
    : [];
  const attempts = [];
  if (strategies.length === 0) return { models: null, strategyId: '', attempts, error: 'no_model_strategy' };

  // 与额度策略链同一条排序规则：不依赖本机客户端的排前面，组内保持声明顺序。
  const ordered = strategies.slice().sort((left, right) => (
    Number(Boolean(left.clientDependent)) - Number(Boolean(right.clientDependent))
  ));

  for (const strategy of ordered) {
    if (ctx.strategyId && strategy.id !== ctx.strategyId) continue;
    try {
      const discoverer = typeof strategy.discover === 'function' ? strategy.discover(ctx.deps || {}) : null;
      if (!discoverer || typeof discoverer.discover !== 'function') {
        attempts.push({ strategyId: strategy.id, error: 'strategy_factory_invalid' });
        continue;
      }
      const result = await discoverer.discover(account, ctx.timeoutMs);
      const models = Array.isArray(result && result.models) ? result.models.filter(Boolean) : null;
      if (models && models.length > 0) return { models, strategyId: strategy.id, attempts, error: '' };
      attempts.push({
        strategyId: strategy.id,
        error: normalizeError(result && result.error) || 'empty_catalog'
      });
    } catch (error) {
      attempts.push({
        strategyId: strategy.id,
        error: `strategy_exception:${normalizeError(error && error.message || error)}`
      });
    }
  }
  const last = attempts[attempts.length - 1] || {};
  return { models: null, strategyId: '', attempts, error: last.error || 'no_model_strategy_succeeded' };
}

function summarizeModelStrategyAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return '';
  return attempts.map((attempt) => `${attempt.strategyId}:${attempt.error}`).join(' | ');
}

module.exports = {
  runProviderModelStrategies,
  summarizeModelStrategyAttempts
};
