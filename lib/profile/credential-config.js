'use strict';

const {
  CLAUDE_CREDENTIAL_TYPES,
  normalizeClaudeCredentialType
} = require('../account/claude-credential');
const {
  PROVIDER_IDS,
  getProviderAuthOptions,
  getProviderCLIConfig
} = require('../provider-catalog');

// API-key 环境变量映射的事实来源是 Go 契约（builtins.go 的 authOptions +
// CLIConfig.EnvKeys），这里按命名约定派生，不再逐 provider 手维护：
//   apiKeys    = EnvKeys 中以 _API_KEY 结尾的项；
//   baseUrlKey = EnvKeys 中以 _BASE_URL 结尾的首项（无则 null）。
// 只为声明了 api-key/auth-token 认证方式的 provider 生成条目。
function deriveCliSpec() {
  const spec = {};
  PROVIDER_IDS.forEach((provider) => {
    const authOptions = getProviderAuthOptions(provider);
    const supportsApiKey = (authOptions || []).some((option) => (
      option && (option.value === 'api-key' || option.value === 'auth-token')
    ));
    if (!supportsApiKey) return;
    const envKeys = (getProviderCLIConfig(provider) || {}).envKeys || [];
    const apiKeys = envKeys.filter((key) => /_API_KEY$/.test(key));
    if (apiKeys.length === 0) return;
    const baseUrlKey = envKeys.find((key) => /_BASE_URL$/.test(key)) || null;
    spec[provider] = Object.freeze({ apiKeys: Object.freeze(apiKeys), baseUrlKey });
  });
  return Object.freeze(spec);
}

const CLI_SPEC = deriveCliSpec();

const ERROR_CODES = Object.freeze({
  UNKNOWN_CLI: 'unknown_cli',
  INVALID_TYPE: 'invalid_type',
  MISSING_CREDENTIAL: 'missing_credential',
  BASE_URL_UNSUPPORTED: 'base_url_unsupported',
  INVALID_BASE_URL: 'invalid_base_url'
});

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeBaseUrl(value) {
  const trimmed = normalizeString(value);
  if (!trimmed) {
    return '';
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_error) {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';

  let normalized = parsed.toString();
  if (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function resultOk(value) {
  return { ok: true, value };
}

function resultError(code, message) {
  return { ok: false, error: { code, message } };
}

function getCliSpec(cliName) {
  const normalizedCli = normalizeString(cliName).toLowerCase();
  if (!normalizedCli || !CLI_SPEC[normalizedCli]) {
    return resultError(ERROR_CODES.UNKNOWN_CLI, 'Unsupported cli name');
  }
  return resultOk({ cli: normalizedCli, spec: CLI_SPEC[normalizedCli] });
}

function readKimiApiKey(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return '';
  for (const key of CLI_SPEC.kimi.apiKeys) {
    const value = normalizeString(env[key]);
    if (value) return value;
  }
  return '';
}

function hasKimiApiKey(env) {
  return Boolean(readKimiApiKey(env));
}

function validateCredentialConfig(input) {
  if (!input || typeof input !== 'object') {
    return resultError(ERROR_CODES.INVALID_TYPE, 'Input must be an object');
  }

  const specResult = getCliSpec(input.cli);
  if (!specResult.ok) {
    return specResult;
  }

  const apiKey = normalizeString(input.api_key);
  const baseUrlRaw = normalizeString(input.base_url);
  const credentialType = specResult.value.cli === 'claude'
    ? (normalizeClaudeCredentialType(input.credential_type || input.auth_type) || CLAUDE_CREDENTIAL_TYPES.API_KEY)
    : '';

  if (!apiKey && !baseUrlRaw) {
    return resultError(
      ERROR_CODES.MISSING_CREDENTIAL,
      'At least one of api_key or base_url is required'
    );
  }

  const cliSpec = specResult.value.spec;
  if (baseUrlRaw && !cliSpec.baseUrlKey) {
    return resultError(
      ERROR_CODES.BASE_URL_UNSUPPORTED,
      'base_url is not supported for this cli'
    );
  }

  let baseUrl = '';
  if (baseUrlRaw) {
    baseUrl = normalizeBaseUrl(baseUrlRaw);
    if (!baseUrl) {
      return resultError(
        ERROR_CODES.INVALID_BASE_URL,
        'base_url must be a valid http(s) URL'
      );
    }
  }

  return resultOk({
    cli: specResult.value.cli,
    api_key: apiKey,
    base_url: baseUrl,
    credential_type: credentialType,
    env_keys: {
      api_key: cliSpec.apiKeys[0],
      all_api_keys: cliSpec.apiKeys.slice(),
      base_url: cliSpec.baseUrlKey
    }
  });
}

function normalizeCredentialConfig(input) {
  const result = validateCredentialConfig(input);
  if (!result.ok) {
    return result;
  }

  const normalized = result.value;
  return resultOk({
    cli: normalized.cli,
    api_key: normalized.api_key,
    base_url: normalized.base_url,
    credential_type: normalized.credential_type
  });
}

module.exports = {
  CLI_SPEC,
  ERROR_CODES,
  getCliSpec,
  hasKimiApiKey,
  normalizeBaseUrl,
  normalizeCredentialConfig,
  readKimiApiKey,
  validateCredentialConfig
};
