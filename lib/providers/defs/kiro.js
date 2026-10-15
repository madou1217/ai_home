'use strict';

// kiro 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：kiro-quota-probe（探针工厂，HTTP）。
const { createKiroQuotaProbe } = require('../../cli/services/usage/kiro-quota-probe');
const usagePort = require('../../usage/provider-usage/kiro');

module.exports = {
  contractVersion: 1,
  id: 'kiro',
  capabilities: {
    quota: {
      supported: true,
      kind: 'kiro_credit_usage',
      source: 'kiro_get_usage_limits_api',
      shape: 'entries',
      entryShape: 'bucket',
      strategies: [
        {
          id: 'kiro-http',
          transport: 'http',
          clientDependent: false,
          probe: (deps) => createKiroQuotaProbe(deps),
          description: 'kiro get-usage-limits（HTTP）'
        }
      ]
    },
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false }
  }
};
