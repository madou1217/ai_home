'use strict';

// CodeBuddy / WorkBuddy 家族的共享描述符工厂（不在 defs/ 顶层，避免被当成 provider）。
//
// 四支（codebuddy / codebuddycn / workbuddy / workbuddycn）同地区 work/code 是同一个账号、
// 同一个余额接口、同一种快照形状，所以共享同一份能力声明，只有 id 不同。

const { goOwnedQuota } = require('../../quota-ownership');
const { goOwnedModels } = require('../../model-ownership');

module.exports = function createCodebuddyFamilyDescriptor(id, options = {}) {
  return {
    contractVersion: 1,
    id,
    capabilities: {
      // 模型发现：云端 /v3/config 的清单已由 Go 产出并落 account_models，Node 只读。
      // 归属登记在 lib/providers/model-ownership.js；HTTP 与 CLI 两条探测链均已退役。
      models: goOwnedModels(id),
      quota: goOwnedQuota(id),
      // 认证来源：家族的本机登录态由宿主凭据同步（后台观察者 + 「扫描本机账号」）整批入库，
      // 因此这里登记的是**扫描来源**而不是单账号导入来源——本机状态本来就是整批的，
      // 硬造一个「逐个导入」入口只会与既有同步链路打架。
      authSources: {
        supported: true,
        sources: [
          {
            id: id + '-host-scan',
            kind: 'local',
            clientDependent: true,
            requires: { app: 'cli' },
            authMode: 'oauth-browser',
            handler: 'host-account-scan',
            description: '扫描本机 CodeBuddy / WorkBuddy 登录态并入库（家族共享凭据同步）'
          }
        ]
      },
      // 账号活动按发行版声明：只有 WorkBuddy 桌面端有每日签到，CodeBuddy 两支没有。
      ...(options.activity ? { activity: options.activity } : {}),
      relay: { transport: 'http', clientDependent: false },
    }
  };
};
