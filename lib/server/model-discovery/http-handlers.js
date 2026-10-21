'use strict';

// 模型发现的 **HTTP handler 注册（组合根）** —— 描述符只声明 `handler: '<id>'`，实现注册在这里。
//
// 搬迁来源：`lib/server/http-utils.js` 里原先按 provider 名分支的模型探测（`if (provider === '…')`）。
// 现在每个实现都在自己的模块里，注册表把 id 映射过去；派发路径不再出现 provider 名。
//
// 模式差异（登录态 / API Key）由描述符的 `modes` 声明，门面筛策略，这里不再判 apiKeyMode。

const { registerModelDiscoveryHandler, getModelDiscoveryHandler } = require('./handler-registry');
const { fetchGenericModelsProbe } = require('./generic-models-probe');
const {
  probeOpenCodeCatalog
} = require('../opencode-server-client');
const { fetchGeminiCodeAssistModels } = require('../http-utils-code-assist');
const { fetchCodexModelsForAccount } = require('../codex-model-client');
const { fetchZcodePlanBalanceModels, createZcodeJwtMissingError } = require('../http-utils-zcode');
const { KNOWN_CLINE_MODELS } = require('../cline-models');
const { discoverNativeCliModels } = require('../native-cli-model-discovery');

/** 把失败的腿写成一句可读原因（进日志/诊断，不参与路由判定）。 */
function describeCatalogGap(legErrors) {
  const parts = Object.entries(legErrors && typeof legErrors === 'object' ? legErrors : {})
    .map(([leg, error]) => `${leg}:${error}`);
  return parts.length > 0 ? `opencode_catalog_incomplete(${parts.join(',')})` : 'opencode_catalog_incomplete';
}

const HANDLERS = {  // 通用 OpenAI/Anthropic 兼容 /models 探测（API Key / 第三方端点账号）。
  'generic-models-probe': (deps) => ({
    discover: (account, timeoutMs) => fetchGenericModelsProbe({
      requestOptions: deps.requestOptions,
      provider: deps.provider,
      account,
      timeoutMs,
      fetchWithTimeout: deps.egressFetchWithTimeout || deps.fetchWithTimeout
    })
  }),
  'opencode-models': (deps) => ({
    discover: async (account, timeoutMs) => {
      // 官方目录是 Go + Zen 两条腿的并集。只探到一条腿时**必须**把残缺标出来：
      // 残缺目录不携带「这个账号不支持其余模型」的证据，下游据此做否定排除会把
      // 免费模型（全在 Zen 腿）判成不可用 → 唯一账号被踢出池 → 恒定 503。
      // 见 opencode-server-client.js 的 probeOpenCodeCatalog。
      const probe = await probeOpenCodeCatalog(deps.requestOptions, account, timeoutMs, {
        fetchWithTimeout: deps.fetchWithTimeout
      });
      const models = Array.isArray(probe && probe.models) ? probe.models : [];
      if (models.length > 0) {
        return probe.incomplete
          ? { models, incomplete: true, error: describeCatalogGap(probe.legErrors) }
          : { models };
      }
      return { error: 'empty_catalog' };
    }
  }),
  'code-assist-models': (deps) => ({
    discover: (account, timeoutMs) => fetchGeminiCodeAssistModels(deps.requestOptions, account, timeoutMs)
  }),
  'codex-native-models': (deps) => ({
    discover: (account, timeoutMs) => fetchCodexModelsForAccount({
      options: deps.requestOptions,
      account,
      fetchWithTimeout: deps.fetchWithTimeout,
      timeoutMs
    })
  }),
  'zcode-plan-models': (deps) => ({
    discover: async (account, timeoutMs) => {
      const planModels = await fetchZcodePlanBalanceModels(deps.requestOptions, account, timeoutMs);
      if (planModels) return { models: planModels };
      // 登录态计划账号：paas 回退凭据（accessToken）必然已过期且无 refresh，探测只会抛 401。
      // 抛「终止型」错误：门面不再重试别的策略，也不会重复出网（api-key 模式由 modes 声明排除）。
      const jwtError = createZcodeJwtMissingError();
      // 该错误对象可能是冻结的（模块级共享），不能直接挂字段 —— 需要时包一层再标记。
      if (Object.isExtensible(jwtError)) {
        jwtError.terminal = true;
        throw jwtError;
      }
      const terminalError = new Error(String(jwtError && jwtError.message || 'zcode_jwt_missing_relogin'));
      terminalError.code = jwtError && jwtError.code;
      terminalError.reloginRequired = Boolean(jwtError && jwtError.reloginRequired);
      terminalError.terminal = true;
      throw terminalError;
    }
  }),
  // 本地 CLI 兜底（transport: cli）：走与历史相同的执行器，只是改由策略链调用。
  'native-cli': (deps) => ({
    discover: async (account, timeoutMs) => {
      const models = await discoverNativeCliModels(deps.requestOptions || {}, account, timeoutMs);
      return Array.isArray(models) && models.length > 0 ? { models } : { error: 'native_cli_no_models' };
    }
  }),
  // 本地静态清单：不联网、不依赖客户端（transport: local）。
  'cline-static-catalog': () => ({
    discover: async () => ({ models: [...KNOWN_CLINE_MODELS] })
  })
};

/** 注册所有内置 HTTP/本地 handler（幂等：已注册则跳过，便于测试与热重载）。 */
function registerBuiltinModelDiscoveryHandlers() {
  const registered = [];
  for (const [id, factory] of Object.entries(HANDLERS)) {
    if (getModelDiscoveryHandler(id)) continue;
    registerModelDiscoveryHandler(id, factory);
    registered.push(id);
  }
  return registered;
}

module.exports = {
  HANDLERS,
  registerBuiltinModelDiscoveryHandlers
};
