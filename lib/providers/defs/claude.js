'use strict';

// claude 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：原生 handler `claude`（组合根提供）；展示端口：lib/usage/provider-usage/claude.js。
const usagePort = require('../../usage/provider-usage/claude');

module.exports = {
  contractVersion: 1,
  id: 'claude',
  capabilities: {
    // 模型发现：**显式回答**该 provider 有没有「不依赖本机客户端」的通道（契约强制）。
    // 没有的话必须写 clientFreeReason 说明原因，否则描述符加载失败（2026-10-15 kiro 教训）。
    models: {
      supported: true,
      source: 'anthropic_models_api',
      strategies: [
        {
          id: 'claude-http-models',
          transport: 'http',
          clientDependent: false,
          handler: 'generic-models-probe', // 实现由组合根注册（lib/server/http-utils.js 的 registerModelDiscoveryHandler）
          description: '通用 /models 探测（OAuth 用 Bearer、API Key 用 x-api-key；第三方代理自动回退路径）'
        }
      ]
    },
    quota: {
      supported: true,
      kind: 'claude_oauth_usage',
      source: 'claude_oauth_usage_api',
      shape: 'entries',
      entryShape: 'window',
      strategies: [
        {
          id: 'claude-http',
          transport: 'http',
          clientDependent: false,
          handler: 'claude',
          description: 'claude 用量接口（HTTP，OAuth 与 auth-token 两种来源）'
        }
      ]
    },
    hooks: {
      supported: true,
      adapter: 'json_hooks',
      target: ['.claude', 'settings.json']
    },
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false },
    // ACP 会话入口：能力登记（入口参数/传输形态的唯一源在 lib/runtime/acp-layouts.js，守卫测试保持三份集合同源）。
    acp: { supported: true }
  }
};
