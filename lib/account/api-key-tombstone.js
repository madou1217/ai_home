'use strict';

// API Key 的「只看密钥」指纹：宿主 API Key 扫描的去重与删除墓碑共用。
//
// 为什么不能只用账号身份：buildApiKeyIdentity 的身份含凭据类型与基础地址，而宿主槽位
// 不一定带得出同一组值（codex 的 auth.json 只存 OPENAI_API_KEY，基础地址在 config.toml；
// claude 的 settings.json 里同一把中转 token 可能写成 ANTHROPIC_AUTH_TOKEN 也可能写成
// ANTHROPIC_API_KEY）。按身份比对会出现两类错误：
//   ① 重复登记：库里已有的 key 以另一种身份再被扫进来一次；
//   ② 删除复活：用户删掉一个中转 key 账号后，宿主槽位里的同一把 key 以「默认官方地址」
//      身份重新登记，把第三方 key 发给它从未打算去的主机。
// 因此去重与墓碑都按「provider + 密钥」比对，与基础地址、凭据类型无关。
//
// 变量名不维护名单：取合同 credential facts 的 apiKeyEnv，并把凭据端口的 importApiKeyEnv
// 在每种凭据类型下实际写出的密钥变量一并纳入（用哨兵值探测哪个变量装的是密钥）。

const nodeCrypto = require('node:crypto');

const API_KEY_TOMBSTONE_PREFIX = 'account:deleted-api-key:';
const CREDENTIAL_TYPES = Object.freeze(['api-key', 'auth-token']);
const SENTINEL_KEY = 'aih-api-key-name-probe-sentinel';

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

/** 该 provider 的账号凭据里可能装着 API Key 的全部变量名。 */
function listProviderApiKeyEnvNames(provider) {
  const p = normalizeProvider(provider);
  if (!p) return [];
  const names = new Set();
  try {
    const { getProviderCredentialFacts } = require('../provider-catalog');
    for (const name of getProviderCredentialFacts(p).apiKeyEnv || []) {
      if (name) names.add(String(name));
    }
  } catch (_error) {
    /* 合同里没有该 provider：只靠凭据端口探测 */
  }
  let strategy = null;
  try {
    strategy = require('./provider-credentials').getProviderCredentialStrategy(p);
  } catch (_error) {
    strategy = null;
  }
  if (strategy && typeof strategy.importApiKeyEnv === 'function') {
    for (const credentialType of CREDENTIAL_TYPES) {
      let env = null;
      try {
        env = strategy.importApiKeyEnv({ apiKey: SENTINEL_KEY, baseUrl: '', credentialType });
      } catch (_error) {
        env = null;
      }
      for (const [name, value] of Object.entries(env && typeof env === 'object' ? env : {})) {
        if (value === SENTINEL_KEY) names.add(name);
      }
    }
  }
  return [...names].sort();
}

/** 从账号凭据 env 里取出全部非空 API Key（去重）。 */
function listApiKeysFromEnv(provider, env) {
  const source = env && typeof env === 'object' ? env : {};
  const keys = new Set();
  for (const name of listProviderApiKeyEnvNames(provider)) {
    const value = String(source[name] || '').trim();
    if (value) keys.add(value);
  }
  return [...keys];
}

/** provider + 密钥的不可逆指纹；墓碑里只存它，绝不落明文密钥。 */
function apiKeyFingerprint(provider, apiKey) {
  const p = normalizeProvider(provider);
  const key = String(apiKey || '').trim();
  if (!p || !key) return '';
  return nodeCrypto.createHash('sha256').update(`${p}\u0000${key}`).digest('hex');
}

function buildApiKeyTombstoneKey(provider, apiKey) {
  const fingerprint = apiKeyFingerprint(provider, apiKey);
  return fingerprint ? `${API_KEY_TOMBSTONE_PREFIX}${fingerprint}` : '';
}

/** 在已打开的事务里为账号凭据中的每把 key 写墓碑（deleteAccountRef 调用）。 */
function writeApiKeyTombstonesInDatabase(db, provider, env, now = Date.now()) {
  let written = 0;
  for (const apiKey of listApiKeysFromEnv(provider, env)) {
    const key = buildApiKeyTombstoneKey(provider, apiKey);
    if (!key) continue;
    db.prepare(`INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, JSON.stringify({ deletedAt: now }), now);
    written += 1;
  }
  return written;
}

/** 这把 key 是否被用户删过（任一身份）。读失败按「没有」处理。 */
function isApiKeyTombstoned(fs, aiHomeDir, provider, apiKey) {
  const key = buildApiKeyTombstoneKey(provider, apiKey);
  if (!key) return false;
  try {
    const { readJsonValue } = require('../server/app-state-store');
    const value = readJsonValue(fs, aiHomeDir, key);
    return Boolean(value && Number(value.deletedAt) > 0);
  } catch (_error) {
    return false;
  }
}

module.exports = {
  API_KEY_TOMBSTONE_PREFIX,
  apiKeyFingerprint,
  buildApiKeyTombstoneKey,
  isApiKeyTombstoned,
  listApiKeysFromEnv,
  listProviderApiKeyEnvNames,
  writeApiKeyTombstonesInDatabase
};
