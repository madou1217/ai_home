'use strict';

const { createCodebuddyFamilyCredentials } = require('./codebuddy-family');
const { createQoderFamilyCredentials } = require('./qoder-family');

/**
 * Provider 凭据端口注册表：每家 provider 一个模块，承载它私有的凭据知识；
 * 调用方只依赖端口，不再按 provider 名写分支。没有模块的 provider 使用中性默认实现
 * （读不出原生凭据、不参与原生身份去重），即「能力明确缺席」。
 *
 * 契约（与 contracts/plugins 的 id / capability 对齐）：
 * - id / capability='provider.credentials'
 * - dedupeByNativeIdentity: 捕获/登记原生凭据时按原生身份去重与防串号
 * - emailIsIdentity: 邮箱是该 provider 唯一可用的身份（gemini、agy），其余 provider 禁止以邮箱作身份
 * - extractNativeAuth(source) → 身份计算用的原生凭据载荷；null 表示没有
 * - nativeIdentitySeed(auth, { provider, source }) → 稳定身份种子；'' 表示无法确认
 * - fallbackIdentity(source)?  → 没有原生载荷时的替代身份 { identitySeed, kind }
 */
const CREDENTIAL_STRATEGIES = Object.freeze([
  require('./codex'),
  require('./claude'),
  require('./gemini'),
  require('./agy'),
  require('./opencode'),
  require('./grok'),
  createQoderFamilyCredentials('qoder'),
  createQoderFamilyCredentials('qodercn'),
  require('./kimi'),
  require('./kiro'),
  require('./zcode'),
  createCodebuddyFamilyCredentials('codebuddy'),
  createCodebuddyFamilyCredentials('codebuddycn'),
  createCodebuddyFamilyCredentials('workbuddy'),
  createCodebuddyFamilyCredentials('workbuddycn')
]);

const DEFAULT_CREDENTIAL_STRATEGY = Object.freeze({
  id: '',
  capability: 'provider.credentials',
  dedupeByNativeIdentity: false,
  emailIsIdentity: false,
  extractNativeAuth: () => null,
  nativeIdentitySeed: () => ''
});

// 预先把每个模块与默认实现合并，调用方拿到的总是完整契约。
const STRATEGY_BY_ID = new Map(CREDENTIAL_STRATEGIES.map((strategy) => [
  strategy.id,
  Object.freeze({ ...DEFAULT_CREDENTIAL_STRATEGY, ...strategy })
]));

function getProviderCredentialStrategy(provider) {
  return STRATEGY_BY_ID.get(String(provider || '').trim().toLowerCase()) || DEFAULT_CREDENTIAL_STRATEGY;
}

module.exports = {
  CREDENTIAL_STRATEGIES,
  getProviderCredentialStrategy
};
