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
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false }
  }
};
