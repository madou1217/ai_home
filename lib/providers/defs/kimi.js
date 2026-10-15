'use strict';

// kimi 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：kimi-quota-probe（探针工厂，HTTP）。
const { createKimiQuotaProbe } = require('../../cli/services/usage/kimi-quota-probe');
const usagePort = require('../../usage/provider-usage/kimi');

module.exports = {
  contractVersion: 1,
  id: 'kimi',
  capabilities: {
    quota: {
      supported: true,
      kind: 'kimi_oauth_usage',
      source: 'kimi_oauth_usages_api',
      shape: 'entries',
      entryShape: 'window',
      strategies: [
        {
          id: 'kimi-http',
          transport: 'http',
          clientDependent: false,
          probe: (deps) => createKimiQuotaProbe(deps),
          description: 'kimi-code /usages（HTTP）'
        }
      ]
    },
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false }
  }
};
