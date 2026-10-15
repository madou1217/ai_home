'use strict';

// codex 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：原生 handler `codex`（组合根提供）；展示端口：lib/usage/provider-usage/codex.js。
const usagePort = require('../../usage/provider-usage/codex');

module.exports = {
  contractVersion: 1,
  id: 'codex',
  capabilities: {
    // 模型发现：**显式回答**该 provider 有没有「不依赖本机客户端」的通道（契约强制）。
    // 没有的话必须写 clientFreeReason 说明原因，否则描述符加载失败（2026-10-15 kiro 教训）。
    models: {
      supported: true,
      source: 'codex_native_models_endpoint',
      strategies: [
        {
          modes: ['login'], // 登录态账号
          id: 'codex-http-models',
          transport: 'http',
          clientDependent: false,
          handler: 'codex-native-models', // 实现由组合根注册（lib/server/http-utils.js 的 registerModelDiscoveryHandler）
          description: 'Codex 原生 /models（OAuth 走 codex-model-client；API Key 走通用 /models 探测）'
        },
        {
          // 模式差异：上面的策略只适用于登录态账号；API Key / 第三方端点账号走通用 /models 探测。
          // 模式不适用时 handler 返回 not_applicable_*，链自动切到这一条（不是 if/else 分支）。
          modes: ['api-key'], // API Key / 第三方端点账号
          id: 'codex-generic-models',
          transport: 'http',
          clientDependent: false,
          handler: 'generic-models-probe',
          description: '通用 OpenAI/Anthropic 兼容 /models 探测（API Key 模式）'
        }
      ]
    },
    quota: {
      supported: true,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      shape: 'entries',
      entryShape: 'window',
      strategies: [
        {
          id: 'codex-http',
          transport: 'http',
          clientDependent: false,
          clientOptional: true,
          handler: 'codex',
          description: '直连 HTTP 优先，失败才回退本机 codex app-server（阶梯在 handler 内，故可能读客户端版本）'
        }
      ]
    },
    hooks: {
      supported: true,
      adapter: 'json_hooks',
      target: ['.codex', 'hooks.json'],
      // codex 的 SessionStart matcher 只在会话真正开始/恢复时才触发。
      eventMatchers: { SessionStart: 'startup|resume|clear|compact' },
      // codex 的 hooks 还要在 config.toml 里打开特性开关（其它 provider 没有这一步）。
      featureFlag: true
    },
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false }
  }
};
