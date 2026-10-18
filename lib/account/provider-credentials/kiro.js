'use strict';

const { buildKiroIdentitySeed } = require('../kiro-identity');
const { KIRO_SLOT_FLAVOURS } = require('../kiro-auth-metadata');
const { isPlainObject } = require('./transfer-fields');

module.exports = Object.freeze({
  id: 'kiro',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: true,
  extractNativeAuth: (source) => source.auth || null,
  // kiro 的身份证据分散在整份原生凭据里（不只 auth），种子从完整 source 计算。
  nativeIdentitySeed: (_auth, { source }) => buildKiroIdentitySeed(source),
  importAliases: [],
  transferIdentitySeed: (auth) => buildKiroIdentitySeed(auth),
  /**
   * 凭据来源槽（authSlot）→ 显式 flavor。
   *
   * **为什么必须显式落库**：social / external-idp 账号没有 device-registration，
   * 刷新时若靠「有没有 registration」判型会被猜成 odic（打错端点 → 401）。
   * 判型优先读显式字段（kiro-token-flavour.js 的 'explicit' 分支），落一次就永久确定。
   *
   * 放在凭据策略里（而不是投影函数里写 provider 名分支）：这是**该 provider 的凭据知识**，
   * 与 extractNativeAuth / identitySeed 同类；投影层只问策略，不认 provider 名。
   */
  normalizeFlavor: (nativeAuth) => {
    if (!isPlainObject(nativeAuth)) return null;
    const slot = String(nativeAuth.authSlot || '').trim();
    if (!slot) return null;
    const flavor = KIRO_SLOT_FLAVOURS[slot];
    const next = { ...nativeAuth };
    // authSlot 是**读取时的中间产物**，不落库：落库的是它归一出来的 flavor。
    delete next.authSlot;
    if (flavor) next.flavor = flavor;
    return next;
  },
  // 导入导出只搬 OAuth 授权与登录时观测到的身份证据（identityEvidence，与当前令牌绑定），
  // 不带本机的 database 路径。没有身份证据的账号算不出身份，不导出，避免导入后无法去重。
  exportRecord: (nativeAuth) => (isPlainObject(nativeAuth.auth)
    ? {
      auth: {
        auth: nativeAuth.auth,
        ...(isPlainObject(nativeAuth.identityEvidence) ? { identityEvidence: nativeAuth.identityEvidence } : {})
      },
      meta: {}
    }
    : { auth: {}, meta: {} }),
  exportOAuthKind: (auth) => (buildKiroIdentitySeed(auth) ? 'oauth' : ''),
  sub2apiCredentials: (auth) => ({ ...auth }),
  normalizeImportedOAuth: (account) => {
    const candidate = isPlainObject(account && account.credentials) ? account.credentials : account;
    return isPlainObject(candidate) && buildKiroIdentitySeed(candidate)
      ? { auth: candidate.auth, identityEvidence: candidate.identityEvidence }
      : null;
  },
  importNativeAuth: (auth) => ({ auth: auth.auth, identityEvidence: auth.identityEvidence })
});
