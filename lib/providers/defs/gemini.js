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
    // 模型发现：**显式回答**该 provider 有没有「不依赖本机客户端」的通道（契约强制）。
    // 没有的话必须写 clientFreeReason 说明原因，否则描述符加载失败（2026-10-15 kiro 教训）。
    models: {
      supported: true,
      source: 'code_assist_models_api',
      strategies: [
        {
          id: 'gemini-http-models',
          transport: 'http',
          clientDependent: false,
          discover: () => null, // 由 provider-model-discovery 的 HTTP 通道执行（见 lib/server/provider-model-strategies.js）
          description: 'code-assist 模型目录（OAuth）；API Key 账号走通用 /models 探测'
        }
      ]
    },
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
