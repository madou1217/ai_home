'use strict';

const { buildOpenCodeIdentitySeed } = require('../opencode-identity');

module.exports = Object.freeze({
  id: 'opencode',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => source.auth || null,
  nativeIdentitySeed: (auth) => buildOpenCodeIdentitySeed(auth),
  sub2apiCredentials: (auth) => auth,
  // API Key 账号的原生附属凭据：opencode CLI 只认 auth.json（启动时 OPENCODE_API_KEY 被剥掉），
  // 与 WebUI 手工添加（configureApiKeyAccount）写同一份，宿主环境变量扫描入库时复用。
  apiKeyNativeAuth: (apiKey, current) => require('../opencode-native-auth').mergeOpenCodeNativeAuth(current, apiKey),
  normalizeImportedOAuth: (account) => {
    const credentials = account && account.credentials && typeof account.credentials === 'object' ? account.credentials : null;
    if (credentials && Object.keys(credentials).length > 0) return credentials;
    const auth = account && account.auth && typeof account.auth === 'object' ? account.auth : null;
    if (auth && Object.keys(auth).length > 0) return auth;
    return account && typeof account === 'object' ? account : null;
  }
});
