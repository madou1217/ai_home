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
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false }
  }
};
