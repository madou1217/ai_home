'use strict';

const {
  readAccountCredentialRecord,
  writeAccountNativeAuth
} = require('../server/account-credential-store');

/**
 * OpenCode api-key 账号的原生凭据桥。
 *
 * OpenCode CLI 只从 `~/.local/share/opencode/auth.json` 读凭据，而账号沙箱启动时
 * `OPENCODE_API_KEY` 会被 launch strategy 主动剥离（见
 * `lib/cli/services/ai-cli/launch-profile/opencode-strategy.js` 的 OPENCODE_UNSET_ENV），
 * 同时 `provider-runtime-env.js` 的 ENV_AUTH_KEYS_BY_PROVIDER 不含 opencode，
 * 即 opencode 一律按"必须有文件凭据"处理。两者叠加的后果是：只把 API Key 存进 env 的账号
 * 启动后是零凭据运行（等价匿名），付费模型必然 401。
 *
 * 因此 env 里的 API Key 必须同时投影成原生 auth 结构：
 *   { "opencode-go": { "type": "api", "key": "<apiKey>" },
 *     "opencode":    { "type": "api", "key": "<apiKey>" } }
 * 官方同一把 Key 同时用于 Zen (`opencode`) 与 Go (`opencode-go`) 两个端点，故两处都写。
 */

const OPENCODE_API_KEY_ENV = 'OPENCODE_API_KEY';
const OPENCODE_AUTH_PROVIDERS = Object.freeze(['opencode-go', 'opencode']);

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeApiKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readOpenCodeApiKeyFromEnv(env) {
  if (!isPlainObject(env)) return '';
  return normalizeApiKey(env[OPENCODE_API_KEY_ENV]);
}

function readAuthMap(nativeAuth) {
  return isPlainObject(nativeAuth) && isPlainObject(nativeAuth.auth) ? nativeAuth.auth : null;
}

/** 已经有任意一个 opencode 端点的可用 key 就算凭据齐备。 */
function hasUsableOpenCodeAuth(nativeAuth) {
  const auth = readAuthMap(nativeAuth);
  if (!auth) return false;
  return OPENCODE_AUTH_PROVIDERS.some((provider) => {
    const record = auth[provider];
    return isPlainObject(record) && normalizeApiKey(record.key).length > 0;
  });
}

/** 由单把 API Key 生成官方 auth.json 结构（Zen + Go 双端点）。 */
function buildOpenCodeNativeAuth(apiKey) {
  const key = normalizeApiKey(apiKey);
  if (!key) return null;
  const auth = {};
  OPENCODE_AUTH_PROVIDERS.forEach((provider) => {
    auth[provider] = { type: 'api', key };
  });
  return { auth };
}

/**
 * 把 API Key 合并进既有原生凭据，保留 openai/anthropic 等其它 provider 的条目，
 * 只覆盖 opencode 自己的两个端点。
 */
function mergeOpenCodeNativeAuth(current, apiKey) {
  const derived = buildOpenCodeNativeAuth(apiKey);
  if (!derived) return null;
  const base = isPlainObject(current) ? current : {};
  const currentAuth = readAuthMap(base) || {};
  return {
    ...base,
    auth: { ...currentAuth, ...derived.auth }
  };
}

/**
 * 修复既有账号：env 里有 API Key 但原生凭据缺失时补写，幂等。
 * 不覆盖已有的 opencode key —— 用户在 CLI 内重新登录后的凭据比 env 更新，
 * 显式改 Key 走 WebUI 的写入路径（configureApiKeyAccount）。
 *
 * @returns {{ok: boolean, changed: boolean, reason: string}}
 */
function reconcileOpenCodeNativeAuth(options = {}) {
  const { fs, aiHomeDir, accountRef } = options;
  if (!fs || !String(aiHomeDir || '').trim() || !String(accountRef || '').trim()) {
    return { ok: false, changed: false, reason: 'invalid_arguments' };
  }

  let record = null;
  try {
    record = readAccountCredentialRecord(fs, aiHomeDir, accountRef);
  } catch (_error) {
    return { ok: false, changed: false, reason: 'credential_read_failed' };
  }
  if (!record) return { ok: false, changed: false, reason: 'unknown_account_ref' };

  if (hasUsableOpenCodeAuth(record.nativeAuth)) {
    return { ok: true, changed: false, reason: 'native_auth_present' };
  }

  const apiKey = readOpenCodeApiKeyFromEnv(record.env);
  if (!apiKey) return { ok: false, changed: false, reason: 'missing_credentials' };

  const nextNativeAuth = mergeOpenCodeNativeAuth(record.nativeAuth, apiKey);
  try {
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, nextNativeAuth);
  } catch (_error) {
    return { ok: false, changed: false, reason: 'native_auth_write_failed' };
  }
  return { ok: true, changed: true, reason: 'derived_from_env_api_key' };
}

module.exports = {
  OPENCODE_API_KEY_ENV,
  OPENCODE_AUTH_PROVIDERS,
  buildOpenCodeNativeAuth,
  hasUsableOpenCodeAuth,
  mergeOpenCodeNativeAuth,
  readOpenCodeApiKeyFromEnv,
  reconcileOpenCodeNativeAuth
};
