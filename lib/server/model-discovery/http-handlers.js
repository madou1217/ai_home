'use strict';

// 模型发现的 **HTTP handler 注册（组合根）** —— 描述符只声明 `handler: '<id>'`，实现注册在这里。
//
// 搬迁来源：`lib/server/http-utils.js` 里原先按 provider 名分支的模型探测（`if (provider === '…')`）。
// 现在每个实现都在自己的模块里，注册表把 id 映射过去；派发路径不再出现 provider 名。
//
// 模式差异（登录态 / API Key）由描述符的 `modes` 声明，门面筛策略，这里不再判 apiKeyMode。

const { registerModelDiscoveryHandler, getModelDiscoveryHandler } = require('./handler-registry');
const { fetchGenericModelsProbe } = require('./generic-models-probe');
const { createGoAccountModelDiscoverer } = require('./go-account-models');

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
  // Go 已接管模型发现的 Provider（见 lib/providers/model-ownership.js）：
  // 只读 Go 的 account_models，不再出网探测。
  'go-account-models': (deps) => createGoAccountModelDiscoverer(deps)
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
