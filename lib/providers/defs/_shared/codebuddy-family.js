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
      // 模型发现：CodeBuddy 家族的目录随 App 内嵌运行时下发（解析其 --help），
      // 官方没有公开的模型列表接口 → **只有依赖本机客户端的通道**，必须写清原因（契约强制）。
      models: {
        supported: true,
        clientFreeReason: 'CodeBuddy / WorkBuddy 家族没有公开的模型目录接口：目录随对应发行版 App 的内嵌运行时下发（workbuddy-model-discovery 解析该运行时的 --help），因此模型发现只能依赖本机客户端。',
        strategies: [
          {
            id: id + '-native-cli-models',
            transport: 'cli',
            cli: { discover: 'codebuddy-help' },
            clientDependent: true,
            discover: () => null, // 由 native-cli-model-discovery 执行
            description: 'App 内嵌运行时的模型清单'
          }
        ]
      },
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
      relay: { transport: 'http', clientDependent: false }
    }
  };
};
