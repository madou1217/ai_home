'use strict';

// gemini 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：原生 handler `gemini`（组合根提供）；展示端口：lib/usage/provider-usage/gemini.js。
const usagePort = require('../../usage/provider-usage/gemini');

module.exports = {
  contractVersion: 1,
  id: 'gemini',
  capabilities: {
    quota: {
      supported: true,
      kind: 'gemini_oauth_stats',
      source: 'gemini_refresh_user_quota',
      shape: 'models',
      entryShape: 'models',
      strategies: [
        {
          id: 'gemini-http',
          transport: 'http',
          clientDependent: false,
          handler: 'gemini',
          description: 'gemini 原生配额刷新（HTTP）'
        }
      ]
    },
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false }
  }
};
