'use strict';

// Cline（Cline Pass 订阅 / API Key）账号的登录态摘要。
// 账号页快速快照、账号页 hydration 与 CLI 的 checkStatus 共用这一份判定。
//
// Cline 与 CodeBuddy 家族同理：账号**不进**「投影文件即状态」的那条链路，它在场的唯一
// 事实是 DB 里登记的原生凭据 —— 按 cline 槽位收窄后的 providers.json 文档
// （`nativeAuth.auth`，见 account/cline-credentials.js 的格式说明）。判定直接复用该模块的
// 纯函数，并与 `loadClineServerAccounts` 的入池口径保持一致：
//   - 任一槽位（`cline` / `cline-pass`）有 API Key，或
//   - 任一槽位有 OAuth access / refresh token
// 即视为已登录。access token 过期**不算**未登录：refresh token 是长效凭据，
// token-refresh-daemon 的 cline 策略会把它救回来（池里也是同一取舍）。
//
// 少了这一层判定，cline 账号页只能得出「未配置」，而 `auth_mode=oauth` + 未配置会被
// oauth-pending-state 判成 pending，5 分钟后渲染成「授权超时」——这正是 2026-10-14 的
// 实测故障：宿主 `cline auth` 登录被自动登记、凭据可用、模型可探测，账号页却一直挂
// 「授权超时 / 未配置」。

const {
  readClineApiKey,
  resolveClineAccountName,
  selectClineOAuthCredential
} = require('./cline-credentials');

/**
 * @returns {{configured: boolean, apiKeyMode: boolean, accountName: string, reason: string}}
 */
function summarizeClineAuth(nativeAuth) {
  const doc = nativeAuth && typeof nativeAuth === 'object' ? nativeAuth.auth : null;
  // 与池（loadClineServerAccounts）同一口径：有 API Key 就是 API Key 账号。
  const apiKeyMode = Boolean(readClineApiKey(doc));
  const credential = selectClineOAuthCredential(doc);
  const hasOauthCredential = Boolean(credential && (credential.accessToken || credential.refreshToken));
  const configured = apiKeyMode || hasOauthCredential;
  return {
    configured,
    apiKeyMode,
    // 只有 OAuth 文档才有身份信息；API Key 账号的展示名由调用方兜底。
    accountName: configured ? resolveClineAccountName(doc) : '',
    reason: configured ? '' : 'no_cline_credential'
  };
}

module.exports = { summarizeClineAuth };
