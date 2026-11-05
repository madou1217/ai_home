'use strict';

const { goOwnedQuota } = require('../quota-ownership');
const { goOwnedModels } = require('../model-ownership');

// kiro 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：Go（GetUsageLimits），Node 只读 Go 的快照文档。
//
// **两条策略 = 「不依赖 CLI」与「CLI 兜底」**（策略链按 clientDependent=false 优先自动抉择，
// 失败自动切下一条，attempts 可观察，见 lib/usage/quota/strategies.js）：
//   1. kiro-http-refresh（纯 API）：用凭据里内嵌的 device-registration + refresh_token 走
//      AWS SSO OIDC CreateToken 自刷新，再打 GetUsageLimits。**不需要本地 CLI / 桌面 App。**
//   2. kiro-cli-capture（兜底）：从本地 CLI 的 sqlite 抄它刚刷新的 grant 再探测。
//      仅在拿不到 registration（很老的导入形态）或 OIDC 刷新被拒时才会用到。
const {
  createKiroIdeAuthSource,
  kiroAccountIdentity,
  kiroIdeLocalIdentity,
  readKiroIdeTokenFile
} = require('../../account/kiro-ide-import');
const usagePort = require('../../usage/provider-usage/kiro');

module.exports = {
  contractVersion: 1,
  id: 'kiro',
  capabilities: {
    // 模型发现：Go 的 ListAvailableModels（控制面 V3 按套餐、V2 兜底）已落 account_models，
    // Node 只读。HTTP 与本地 CLI 两条探测链均已退役。
    models: goOwnedModels('kiro'),
    quota: goOwnedQuota('kiro'),
    usage: usagePort,
    // 认证来源：把「这台机器上有哪些可用的账号来源」变成可声明数据。
    // 界面与任务链路只消费 lib/account/auth-sources.js 的解析结果（结合 lib/runtime/host-capabilities.js
    // 的宿主机能力），不自己判断「有没有装 IDE / 能不能装」。
    //   * local  = 读本机登录态（必须声明读的是哪个客户端）；
    //   * remote = 需要用户/上游交互（设备码、粘贴 token），任何机器都可用。
    authSources: {
      supported: true,
      // 账号侧指纹：已入库账号的 refresh_token 哈希（与来源级 identity 同一函数，离线可比）。
      accountIdentity: (nativeAuth) => kiroAccountIdentity(nativeAuth),
      sources: [
        {
          id: 'kiro-ide-local',
          kind: 'local',
          clientDependent: true,
          requires: { app: 'desktop' },
          authMode: 'oauth-refresh-token',
          import: (deps) => createKiroIdeAuthSource(deps),
          // 本机侧指纹：读 Kiro IDE 登录态算出来的键。命中账号池 → 该来源不再显示
          // （用户要求：本机这份登录态已经在账号池里了就不要显示导入入口）。
          identity: (deps) => kiroIdeLocalIdentity(deps || {}),
          // 可用性 = IDE 登录态文件读得到（不是「Kiro.app 在不在」）。
          available: (deps) => readKiroIdeTokenFile(deps || {}).ok,
          description: '读取本机 Kiro IDE 的登录态（~/.aws/sso/cache/kiro-auth-token.json），不需要用户手动拷文件'
        },
        {
          id: 'kiro-device-code',
          kind: 'remote',
          clientDependent: false,
          authMode: 'oauth-device',
          handler: 'device-code',
          description: 'AWS SSO OIDC 设备码授权（Builder ID / IAM Identity Center），任意设备可完成'
        },
        {
          // social（Google / GitHub）**也有设备流** —— 这是「换台电脑也能登录」的正解：
          // social 的浏览器 PKCE 流程要求 localhost 回调（`--use-device-flow` 只对 Builder ID /
          // IdC 生效），远程机器上回调打不通，这正是用户遇到的「换台电脑就报错」。
          id: 'kiro-social-device-code',
          kind: 'remote',
          clientDependent: false,
          authMode: 'oauth-device',
          handler: 'social-device-code',
          description: 'Google / GitHub 账号的设备码授权（不需要本机浏览器回调，远程可用）'
        },
        {
          id: 'kiro-paste-token',
          kind: 'remote',
          clientDependent: false,
          authMode: 'oauth-refresh-token',
          handler: 'paste-token',
          description: '粘贴 Kiro Desktop / Google / GitHub 账号的 refresh_token'
        }
      ]
    },
    relay: { transport: 'http', clientDependent: false }
  }
};
