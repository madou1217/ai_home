'use strict';

// CodeBuddy / WorkBuddy 家族的共享描述符工厂（不在 defs/ 顶层，避免被当成 provider）。
//
// 四支（codebuddy / codebuddycn / workbuddy / workbuddycn）同地区 work/code 是同一个账号、
// 同一个余额接口、同一种快照形状，所以共享同一份能力声明，只有 id 不同。

const { createCodebuddyQuotaProbe } = require('../../../cli/services/usage/codebuddy-quota-probe');
const { createCodebuddyFamilyHttpModelDiscovery } = require('../../../account/codebuddy-family-model-discovery');

module.exports = function createCodebuddyFamilyDescriptor(id) {
  return {
    contractVersion: 1,
    id,
    capabilities: {
      // 模型发现：**HTTP 优先**（GET {site}/v3/config，只认账号登录态，不依赖本机 App/CLI），
      // 本机 App 内嵌运行时的 `--help` 作兜底。
      //
      // 反例代价（2026-10-15）：原先只有 CLI 一条路，而 CLI 只随对应发行版桌面 App 提供 ——
      // 没装 App 的机器上模型目录永远为空，账号在账号页/路由里都表现为「没有可用的模型」。
      // 云端 /v3/config 的 `agents[name=cli].models` 与 `--help` 的 Currently supported 同源，
      // 因此 HTTP 通道能独立给出同一份清单（见 lib/account/codebuddy-family-model-discovery.js）。
      models: {
        supported: true,
        source: 'codebuddy_family_v3_config_api',
        strategies: [
          {
            id: id + '-http-models',
            transport: 'http',
            clientDependent: false,
            // 目录按登录态下发；api-key 账号没有这条通道（走 CLI/通用探测）。
            modes: ['login'],
            discover: (deps) => createCodebuddyFamilyHttpModelDiscovery(deps),
            description: '云端 /v3/config 的 cli agent 模型清单（纯 HTTP，不依赖本机客户端）'
          },
          {
            id: id + '-native-cli-models',
            transport: 'cli',
            cli: { discover: 'codebuddy-help' },
            clientDependent: true,
            discover: () => null, // 由 native-cli-model-discovery 执行
            description: 'App 内嵌运行时的模型清单（HTTP 通道不可用时的兜底）'
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
      relay: { transport: 'http', clientDependent: false },
      // ACP 会话入口：能力登记（入口参数/传输形态的唯一源在 lib/runtime/acp-layouts.js，守卫测试保持三份集合同源）。
      acp: { supported: true }
    }
  };
};
