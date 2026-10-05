'use strict';

const { normalizeUuidComponent } = require('../identity-components');

function extractClaudeNativeId(auth) {
  const oauth = auth && (auth.claudeAiOauth || auth.claude_ai_oauth);
  const account = oauth && oauth.account;
  const uuid = account && (account.uuid || account.account_uuid || account.accountUuid);
  return normalizeUuidComponent(uuid);
}

module.exports = Object.freeze({
  id: 'claude',
  capability: 'provider.credentials',
  extractNativeAuth: (source) => source.credentials || null,
  // Claude OAuth 的身份向量是 `oauth:claude:uuid:<account_uuid>`（§8.1 的表格明文规定），
  // 邮箱不参与：带 `claudeAiOauth.email` 的凭据走邮箱向量会铸出 Go 永远不会产生的种子。
  // 拿不到合法 UUID 时不回退邮箱——§8.1 要求稳定字段缺失时返回 identity_unverifiable，Go 侧同样拒绝。
  nativeIdentitySeed: (auth) => {
    const nativeId = extractClaudeNativeId(auth);
    return nativeId ? `oauth:claude:uuid:${nativeId}` : '';
  },
  extractClaudeNativeId
});
