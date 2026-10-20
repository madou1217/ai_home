'use strict';

const { buildOpenCodeIdentitySeed } = require('../opencode-identity');
const { hasNonEmptyObject, objectOrEmpty } = require('./transfer-fields');

module.exports = Object.freeze({
  id: 'opencode',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => source.auth || null,
  nativeIdentitySeed: (auth) => buildOpenCodeIdentitySeed(auth),
  importAliases: [],
  transferIdentitySeed: (auth) => buildOpenCodeIdentitySeed(auth.auth || auth),
  exportRecord: (nativeAuth) => ({ auth: objectOrEmpty(nativeAuth.auth), meta: {} }),
  exportOAuthKind: (auth) => (hasNonEmptyObject(auth) ? 'oauth' : ''),
  sub2apiCredentials: (auth) => auth,
  // 标准格式身份种子直接取导入载荷，不拆 auth 包装。
  standardIdentitySeed: (auth) => buildOpenCodeIdentitySeed(auth),
  // 扁平导出按 accountRef 命名；导出保留已登记的授权，不在这里重新校验（避免老用户无法备份）。
  flatExportFileStem: (record) => (record.auth && typeof record.auth === 'object' ? 'auth' : null),
  // API Key 账号的原生附属凭据：opencode CLI 只认 auth.json（启动时 OPENCODE_API_KEY 被剥掉），
  // 与 WebUI 手工添加（configureApiKeyAccount）写同一份，宿主环境变量扫描入库时复用。
  apiKeyNativeAuth: (apiKey, current) => require('../opencode-native-auth').mergeOpenCodeNativeAuth(current, apiKey),
  importNativeAuth: (auth) => ({ auth }),
  normalizeImportedOAuth: (account) => {
    const credentials = account && account.credentials && typeof account.credentials === 'object' ? account.credentials : null;
    if (credentials && Object.keys(credentials).length > 0) return credentials;
    const auth = account && account.auth && typeof account.auth === 'object' ? account.auth : null;
    if (auth && Object.keys(auth).length > 0) return auth;
    return account && typeof account === 'object' ? account : null;
  }
});
