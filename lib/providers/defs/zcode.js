'use strict';

// zcode 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：zcode-quota-probe（探针工厂，HTTP）。
const { createZcodeQuotaProbe } = require('../../cli/services/usage/zcode-quota-probe');

module.exports = {
  contractVersion: 1,
  id: 'zcode',
  capabilities: {
    quota: {
      supported: true,
      kind: 'zcode_plan_balance',
      source: 'zcode_plan_billing_balance_api',
      shape: 'entries',
      entryShape: 'bucket',
      strategies: [
        {
          id: 'zcode-http',
          transport: 'http',
          clientDependent: false,
          probe: (deps) => createZcodeQuotaProbe(deps),
          description: 'Coding Plan 余额接口（HTTP，需 API Key 账号）'
        }
      ]
    },
    relay: { transport: 'http', clientDependent: false }
  }
};
