'use strict';

const CLI_SPEC = Object.freeze({
  codex: { apiKeys: ['OPENAI_API_KEY'], baseUrlKey: 'OPENAI_BASE_URL' },
  claude: { apiKeys: ['ANTHROPIC_API_KEY'], baseUrlKey: 'ANTHROPIC_BASE_URL' },
  gemini: { apiKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], baseUrlKey: null }
});

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
    base_url: normalized.base_url
  });
}

module.exports = {
  CLI_SPEC,
  ERROR_CODES,
  getCliSpec,
  normalizeBaseUrl,
  normalizeCredentialConfig,
  validateCredentialConfig
};
