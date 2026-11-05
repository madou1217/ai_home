'use strict';

const { goOwnedQuota } = require('../quota-ownership');
const { goOwnedModels } = require('../model-ownership');

// cline 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：lib/usage/quota/plugins/cline.js（HTTP，Cline 账号面接口）。
const usagePort = require('../../usage/provider-usage/cline');

module.exports = {
  contractVersion: 1,
  id: 'cline',
  capabilities: {
    // 模型发现：静态规范清单已由 Go 产出（adapters/cline/modelcatalog），Node 只读。
    // 归属登记在 lib/providers/model-ownership.js。
    models: goOwnedModels('cline'),
    quota: goOwnedQuota('cline'),
    usage: usagePort,
    // 认证来源：cline 的宿主登录态由既有同步链路（后台观察者 + 「扫描本机账号」）入库，
    // 因此登记扫描来源而不是单账号导入来源。
    authSources: {
      supported: true,
      sources: [
        {
          id: 'cline-host-scan',
          kind: 'local',
          clientDependent: true,
          requires: { app: 'cli' },
          authMode: 'oauth-browser',
          handler: 'host-account-scan',
          description: '扫描本机 cline 登录态并入库（宿主 ~/.cline 凭据同步）'
        }
      ]
    },
    relay: { transport: 'http', clientDependent: false },
  }
};
