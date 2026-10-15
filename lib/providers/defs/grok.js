'use strict';

// grok 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：grok-quota-probe（探针工厂，HTTP）。
const { createGrokQuotaProbe } = require('../../cli/services/usage/grok-quota-probe');
const usagePort = require('../../usage/provider-usage/grok');

module.exports = {
  contractVersion: 1,
  id: 'grok',
  capabilities: {
    quota: {
      supported: true,
      kind: 'grok_credit_usage',
      source: 'grok_build_billing_api',
      shape: 'entries',
      entryShape: 'bucket',
      strategies: [
        {
          id: 'grok-http',
          transport: 'http',
          clientDependent: false,
          probe: (deps) => createGrokQuotaProbe(deps),
          description: 'grok build 账单接口（HTTP）'
        }
      ]
    },
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false }
  }
};
