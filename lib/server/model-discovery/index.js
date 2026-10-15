'use strict';

// 模型发现的**门面**：`discoverProviderModelsViaStrategies(provider, account, ctx)`。
//
// 消费方（http-utils / provider-model-discovery / 将来的其它入口）只需要问门面，
// 门面从**描述符倒排索引**取该 provider 的策略链，按 `clientDependent=false` 优先执行，
// 失败自动切下一条，`attempts` 可观察。新增 provider 不需要改这里。
//
// 与额度策略链同一套语义（lib/usage/quota/strategies.js），但 handler 解析走本目录的注册表。

const { getProviderCapability } = require('../../providers');
const { getModelDiscoveryHandler } = require('./handler-registry');

function normalizeError(value) {
  return String(value === undefined || value === null ? '' : value).slice(0, 200);
}

/** 该 provider 声明的模型发现策略（已按 client-free 优先排序）。 */
function listModelDiscoveryStrategies(provider, options = {}) {
  const capability = getProviderCapability(provider, 'models', options);
  if (!capability || capability.supported !== true) return [];
  const strategies = Array.isArray(capability.strategies) ? capability.strategies : [];
  return strategies.slice().sort((left, right) => (
    Number(Boolean(left.clientDependent)) - Number(Boolean(right.clientDependent))
  ));
}

/**
 * 依次尝试该 provider 的模型发现策略。
 * @returns {Promise<{models: string[]|null, strategyId: string, attempts: Array<object>, error: string}>}
 */
async function discoverProviderModelsViaStrategies(provider, account, ctx = {}) {
  const strategies = listModelDiscoveryStrategies(provider, ctx.options || {});
  const attempts = [];
  if (strategies.length === 0) return { models: null, strategyId: '', attempts, error: 'no_model_strategy' };

  // 账号模式（数据驱动，不写 if(apiKeyMode)）：策略声明的 modes 不含当前模式就跳过。
  const isApiKeyAccount = Boolean(account && (account.apiKeyMode === true
    || String(account.authType || '').trim().toLowerCase() === 'api-key'));
  const accountMode = isApiKeyAccount ? 'api-key' : 'login';

  const transports = Array.isArray(ctx.transports) && ctx.transports.length > 0 ? ctx.transports : null;

  for (const strategy of strategies) {
    if (ctx.strategyId && strategy.id !== ctx.strategyId) continue;
    // transport 过滤：local（本地静态清单）要在出网解析之前跑，http/cli 之后跑。
    if (transports && !transports.includes(strategy.transport)) {
      attempts.push({ strategyId: strategy.id, error: `skipped_transport:${strategy.transport}` });
      continue;
    }
    const modes = Array.isArray(strategy.modes) ? strategy.modes : [];
    if (modes.length > 0 && !modes.includes(accountMode)) {
      attempts.push({ strategyId: strategy.id, error: `not_applicable_mode:${accountMode}` });
      continue;
    }
    try {
      // 两种声明方式：内联工厂（discover）或注册表 handler（handler）——后者让实现留在原地，
      // 描述符只声明 id（组合根注入，同额度策略）。
      let discoverer = null;
      if (typeof strategy.discover === 'function') {
        discoverer = strategy.discover(ctx.deps || {});
      } else if (strategy.handler) {
        const factory = getModelDiscoveryHandler(strategy.handler);
        if (typeof factory !== 'function') {
          attempts.push({ strategyId: strategy.id, error: `handler_unavailable:${strategy.handler}` });
          continue;
        }
        discoverer = factory(ctx.deps || {});
      }
      if (!discoverer || typeof discoverer.discover !== 'function') {
        attempts.push({ strategyId: strategy.id, error: 'strategy_factory_invalid' });
        continue;
      }
      const result = await discoverer.discover(account, ctx.timeoutMs);
      const models = Array.isArray(result && result.models) ? result.models.filter(Boolean) : null;
      if (models && models.length > 0) return { models, strategyId: strategy.id, attempts, error: '' };
      attempts.push({ strategyId: strategy.id, error: normalizeError(result && result.error) || 'empty_catalog' });
    } catch (error) {
      // 「终止型」错误（例如 zcode_jwt_missing_relogin：必须重新登录，重试别的策略只会重复出网）
      // 直接上抛，不吞成 attempts —— 否则调用方既拿不到准确原因，又会重复探测。
      if (error && (error.terminal === true || error.reloginRequired === true)) throw error;
      attempts.push({
        strategyId: strategy.id,
        error: `strategy_exception:${normalizeError(error && error.message || error)}`
      });
    }
  }
  if (process.env.AIH_DEBUG_MODEL_CHAIN) console.error('[model-chain]', provider, JSON.stringify(attempts));
  const last = attempts[attempts.length - 1] || {};
  return { models: null, strategyId: '', attempts, error: last.error || 'no_model_strategy_succeeded' };
}

function summarizeModelStrategyAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return '';
  return attempts.map((attempt) => `${attempt.strategyId}:${attempt.error}`).join(' | ');
}

module.exports = {
  listModelDiscoveryStrategies,
  discoverProviderModelsViaStrategies,
  summarizeModelStrategyAttempts
};
