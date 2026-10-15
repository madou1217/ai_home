'use strict';

// CodeBuddy / WorkBuddy 家族的共享描述符工厂（不在 defs/ 顶层，避免被当成 provider）。
//
// 四支（codebuddy / codebuddycn / workbuddy / workbuddycn）同地区 work/code 是同一个账号、
// 同一个余额接口、同一种快照形状，所以共享同一份能力声明，只有 id 不同。

const { createCodebuddyQuotaProbe } = require('../../../cli/services/usage/codebuddy-quota-probe');

module.exports = function createCodebuddyFamilyDescriptor(id) {
  return {
    contractVersion: 1,
    id,
    capabilities: {
      quota: {
        supported: true,
        kind: 'codebuddy_credit_balance',
        source: 'codebuddy_billing_resource_summary_api',
        shape: 'entries',
        entryShape: 'bucket',
        strategies: [
          {
            id: id + '-http',
            transport: 'http',
            clientDependent: false,
            // 凭据读取可能落到桌面端加密存储（macOS 走 Keychain 取密钥），
            // 因此是 clientOptional：没有桌面端时用 CLI 落盘的明文凭据同样可探。
            clientOptional: true,
            probe: (deps) => createCodebuddyQuotaProbe(deps),
            description: '家族资源汇总接口（HTTP）；凭据优先取 CLI 明文文件，缺失时才读桌面端加密存储'
          }
        ]
      },
      relay: { transport: 'http', clientDependent: false }
    }
  };
};
