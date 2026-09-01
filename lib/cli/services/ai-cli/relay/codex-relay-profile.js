'use strict';

// codex 的 relay 与 env+header 注入不同构：账号 env 自带指向网关的
// OPENAI_BASE_URL/OPENAI_API_KEY，relay 整形靠 `-c model_provider=...`
// 参数手术（codex-provider-args.js）加 config.toml 受管块
// （codex-config-sync + scripts/aih-codex-provider-auth.js 三级取 key）。
// 本模块是委托给该现有机制的薄适配器，不重写 codex 逻辑：
// - shouldRelayAccount 恒 false（没有 env 注入式钉账号 relay）；
// - 启动整形经 buildRelayLaunch 暴露（接口为此容纳 args 差异），
//   返回 { args } env 补丁恒为空。
const {
  buildCodexProviderArgs,
  hasCodexModelProviderArg,
  injectCodexProviderArgs
} = require('../codex-provider-args');

const codexRelayProfile = Object.freeze({
  provider: 'codex',
  shouldRelayAccount: () => false,
  buildGatewayProfileEnv(urls) {
    return {
      OPENAI_API_KEY: urls.apiKey,
      OPENAI_BASE_URL: urls.baseUrl
    };
  },
  // input: { args, accountEnv, isLogin, gateway }；返回 { args } 或 null。
  buildRelayLaunch(input = {}) {
    if (input.isLogin === true) return null;
    const args = Array.isArray(input.args) ? input.args : [];
    if (hasCodexModelProviderArg(args)) return null;
    return {
      args: injectCodexProviderArgs(
        args,
        buildCodexProviderArgs(input.accountEnv, { force: input.gateway === true })
      )
    };
  }
});

module.exports = { codexRelayProfile };
