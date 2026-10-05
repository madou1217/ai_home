'use strict';

const { buildCodexOAuthIdentitySeed } = require('../codex-auth-metadata');

module.exports = Object.freeze({
  id: 'codex',
  capability: 'provider.credentials',
  extractNativeAuth: (source) => source.auth || null,
  // Codex OAuth 的身份向量是 `oauth:codex:<user_id>`，与 Go 逐字节一致；邮箱只用于展示
  // 与导入关联，不参与身份。见 docs/architecture/codex-oauth-identity-vector-adr.md。
  nativeIdentitySeed: (auth) => buildCodexOAuthIdentitySeed(auth)
});
