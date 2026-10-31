'use strict';

const { createCodebuddyFamilyCredentials } = require('./codebuddy-family');
const { createQoderFamilyCredentials } = require('./qoder-family');
const { FAMILY_PROVIDERS } = require('../../runtime/codebuddy-family-layouts');

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
 * 凭据身份辅助（账号迁移格式见 ../native-account-transfer.js，按原生凭据推导身份，无需逐 provider 的映射）：
 * - transferEmailCandidates(fields, helpers)? → 凭据载荷里的邮箱候选（按优先级），缺省只看通用位置
 * - importCredentialEnv?: { keys, credentialType } provider 专属的 API Key 凭据变量
 * - importApiKeyEnv(config)? → API Key 写入哪些 env 变量（宿主扫描入库时用）
 * - hostApiKeySlots?: [{ path, format: 'json'|'dotenv', select(doc) → {apiKey, baseUrl?, credentialType}|null }]
 *   宿主上 provider **自己的** API Key 落点（相对宿主家目录）；「扫描本机账号」只从这里取 API Key，
 *   绝不读通用环境变量。没声明 = 该 provider 宿主上没有可确认的 API Key 槽位。
 * - goAccountImports?: { '<authKind>:<authMode>': (snapshot) => { env?, nativeAuth?, identitySeed? } }
 *   本机 Go 快照的可逆导入策略；未声明的类型保留为 Go 独有账号。
 */
const CREDENTIAL_STRATEGIES = Object.freeze([
  require('./codex'),
  require('./claude'),
  require('./gemini'),
  require('./agy'),
  require('./opencode'),
  require('./grok'),
  require('./cline'),
  createQoderFamilyCredentials('qoder'),
  createQoderFamilyCredentials('qodercn'),
  require('./kimi'),
  require('./kiro'),
  require('./zcode'),
  // 家族四支从布局模块展开：新增成员自动获得凭据策略，不会静默缺一条。
  ...FAMILY_PROVIDERS.map((provider) => createCodebuddyFamilyCredentials(provider))
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
