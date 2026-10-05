'use strict';

const path = require('node:path');
const { buildGrokIdentitySeed } = require('./grok-identity');
const { normalizeEmailComponent, normalizeUuidComponent } = require('./identity-components');
const { buildOpenCodeIdentitySeed } = require('./opencode-identity');
const { buildKimiIdentitySeed, buildZcodeIdentitySeed, buildCodebuddyIdentitySeed } = require('./subject-oauth-identity');
const { buildKiroIdentitySeed } = require('./kiro-identity');
const { buildQoderIdentitySeed } = require('./qoder-auth-metadata');
const { CREDENTIAL_STRATEGIES, getProviderCredentialStrategy } = require('./provider-credentials');
const { firstNonEmptyString, genericEmailCandidates } = require('./provider-credentials/transfer-fields');
const {
  buildCodexOAuthIdentitySeed,
  decodeJwtPayloadUnsafe,
  extractCodexMetadata,
  normalizeCodexRefreshToken
} = require('./codex-auth-metadata');
const { AGY_CLI_AUTH_METHOD } = require('./agy-auth-metadata');
const {
  readAccountCredentials,
  readAccountNativeAuth
} = require('../server/account-credential-store');

const SUB2API_RECORD_METADATA_KEY = '__sub2api';
const CLIPROXYAPI_DATA_TYPE = 'cliproxyapi-data';
const SUB2API_ACCOUNT_METADATA_FIELDS = Object.freeze([
  'notes',
  'proxy_key',
  'concurrency',
  'priority',
  'rate_multiplier',
  'expires_at',
  'auto_pause_on_expired'
]);

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeCredentialType(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (normalized === 'apikey') return 'api-key';
  return normalized;
}

// 导入文件里的 provider 名 → 内置 provider id。别名与可导入的 id 都由凭据端口模块声明
// （声明了 importAliases 的 provider 才支持标准格式 / sub2api 导入）。
const IMPORT_PROVIDER_BY_NAME = new Map(CREDENTIAL_STRATEGIES
  .filter((strategy) => Array.isArray(strategy.importAliases))
  .flatMap((strategy) => [[strategy.id, strategy.id], ...strategy.importAliases.map((alias) => [alias, strategy.id])]));

function normalizeImportProviderAlias(value) {
  const provider = normalizeProvider(value);
  if (!provider) return '';
  return IMPORT_PROVIDER_BY_NAME.get(provider) || '';
}

function parseJsonFileSafe(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function extractEmailFromJwt(token) {
  const payload = decodeJwtPayloadUnsafe(token);
  if (!payload || typeof payload !== 'object') return '';
  const profile = payload['https://api.openai.com/profile'];
  return firstNonEmptyString(
    payload.email,
    payload.emailAddress,
    profile && profile.email,
    payload.account && payload.account.email,
    payload.user && payload.user.email
  );
}

const EMAIL_HELPERS = Object.freeze({ extractCodexMetadata, extractEmailFromJwt });
// extractOAuthEmail 为函数声明，提升后可在此引用。
const EXPORT_HELPERS = Object.freeze({ extractOAuthEmail });

function extractOAuthEmail(provider, auth) {
  const p = normalizeProvider(provider);
  const payload = auth && typeof auth === 'object' ? auth : {};
  const nestedAuth = payload.auth && typeof payload.auth === 'object' ? payload.auth : {};
  const config = payload.config && typeof payload.config === 'object' ? payload.config : {};
  const credentials = payload.credentials && typeof payload.credentials === 'object' ? payload.credentials : {};
  const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};
  const source = Object.keys(nestedAuth).length > 0 ? nestedAuth : payload;
  const tokens = source.tokens && typeof source.tokens === 'object' ? source.tokens : {};
  const fields = { payload, nestedAuth, config, credentials, meta, source, tokens };
  // 各 provider 的邮箱位置由凭据端口模块给出（按优先级）；没声明的只看通用位置。
  const strategy = getProviderCredentialStrategy(p);
  const candidates = typeof strategy.transferEmailCandidates === 'function'
    ? strategy.transferEmailCandidates(fields, EMAIL_HELPERS)
    : genericEmailCandidates(fields);
  return normalizeEmail(firstNonEmptyString(...candidates));
}

/** The transfer boundary uses the same policies as native registration, not an email shortcut. */
function buildOAuthIdentity(provider, auth) {
  const p = normalizeProvider(provider);
  if (!p || !auth || typeof auth !== 'object') return '';
  return getProviderCredentialStrategy(p).transferIdentitySeed(auth) || '';
}

function extractProviderApiKey(p, payload, config, credentials, authCredentials, auth) {
  // provider 专属的凭据变量（凭据端口模块的 importCredentialEnv）优先，按来源再按变量名的顺序取第一个非空值。
  const special = getProviderCredentialStrategy(p).importCredentialEnv;
  if (special) {
    const value = firstNonEmptyString(...[payload, config, credentials, authCredentials, auth]
      .flatMap((source) => special.keys.map((key) => source[key])));
    if (value) return { apiKey: value, credentialType: special.credentialType };
  }

  return {
    apiKey: firstNonEmptyString(
      payload['api-key'],
      payload.apiKey,
      payload.api_key,
      payload.OPENAI_API_KEY,
      payload.ANTHROPIC_API_KEY,
      payload.GEMINI_API_KEY,
      payload.GOOGLE_API_KEY,
      config.apiKey,
      config.api_key,
      config.OPENAI_API_KEY,
      config.ANTHROPIC_API_KEY,
      config.GEMINI_API_KEY,
      config.GOOGLE_API_KEY,
      credentials['api-key'],
      credentials.apiKey,
      credentials.api_key,
      credentials.OPENAI_API_KEY,
      credentials.ANTHROPIC_API_KEY,
      credentials.GEMINI_API_KEY,
      credentials.GOOGLE_API_KEY,
      authCredentials['api-key'],
      authCredentials.apiKey,
      authCredentials.api_key,
      authCredentials.OPENAI_API_KEY,
      authCredentials.ANTHROPIC_API_KEY,
      authCredentials.GEMINI_API_KEY,
      authCredentials.GOOGLE_API_KEY,
      auth.OPENAI_API_KEY,
      auth.ANTHROPIC_API_KEY,
      auth.GEMINI_API_KEY,
      auth.GOOGLE_API_KEY
    ),
    credentialType: 'api-key'
  };
}

function extractApiKeyConfig(provider, record) {
  const p = normalizeProvider(provider);
  const payload = record && typeof record === 'object' ? record : {};
  const config = payload.config && typeof payload.config === 'object' ? payload.config : {};
  const auth = payload.auth && typeof payload.auth === 'object' ? payload.auth : {};
  const credentials = payload.credentials && typeof payload.credentials === 'object' ? payload.credentials : {};
  const authCredentials = auth.credentials && typeof auth.credentials === 'object' ? auth.credentials : {};
  const rawTokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : null;
  const hasOauthTokens = Boolean(rawTokens && (rawTokens.refresh_token || rawTokens.access_token || rawTokens.id_token));
  if (hasOauthTokens) return { apiKey: '', baseUrl: '' };

  const credential = extractProviderApiKey(p, payload, config, credentials, authCredentials, auth);
  const baseUrl = firstNonEmptyString(
    payload['base-url'],
    payload.baseUrl,
    payload.base_url,
    payload.OPENAI_BASE_URL,
    payload.ANTHROPIC_BASE_URL,
    payload.GEMINI_BASE_URL,
    payload.XAI_BASE_URL,
    payload.KIMI_BASE_URL,
    config['base-url'],
    config.baseUrl,
    config.base_url,
    config.OPENAI_BASE_URL,
    config.ANTHROPIC_BASE_URL,
    config.GEMINI_BASE_URL,
    config.XAI_BASE_URL,
    config.KIMI_BASE_URL,
    credentials['base-url'],
    credentials.baseUrl,
    credentials.base_url,
    credentials.OPENAI_BASE_URL,
    credentials.ANTHROPIC_BASE_URL,
    credentials.GEMINI_BASE_URL,
    credentials.XAI_BASE_URL,
    credentials.KIMI_BASE_URL,
    authCredentials['base-url'],
    authCredentials.baseUrl,
    authCredentials.base_url,
    authCredentials.OPENAI_BASE_URL,
    authCredentials.ANTHROPIC_BASE_URL,
    authCredentials.GEMINI_BASE_URL,
    authCredentials.XAI_BASE_URL,
    authCredentials.KIMI_BASE_URL,
    auth.OPENAI_BASE_URL,
    auth.ANTHROPIC_BASE_URL,
    auth.GEMINI_BASE_URL,
    auth.XAI_BASE_URL,
    auth.KIMI_BASE_URL
  );
  return {
    apiKey: String(credential.apiKey || '').trim(),
    baseUrl: normalizeBaseUrl(baseUrl),
    provider: p,
    credentialType: credential.credentialType
  };
}

function buildApiKeyIdentity(provider, config) {
  const p = normalizeProvider(provider);
  const extracted = extractApiKeyConfig(p, config);
  if (!p || !extracted.apiKey) return '';
  const prefix = extracted.credentialType === 'auth-token' ? 'auth_token' : 'api_key';
  return `${prefix}:${p}:${normalizeBaseUrl(extracted.baseUrl)}:${encodeURIComponent(extracted.apiKey)}`;
}

function normalizeCodexAuthPayload(input) {
  const payload = input && typeof input === 'object' ? input : null;
  if (!payload) return null;

  const existingTokens = payload.tokens && typeof payload.tokens === 'object' ? payload.tokens : null;
  const credentials = payload.credentials && typeof payload.credentials === 'object' ? payload.credentials : {};
  const accessToken = String(payload.access_token || payload.accessToken || credentials.access_token || credentials.accessToken || (existingTokens && existingTokens.access_token) || '').trim();
  const refreshToken = normalizeCodexRefreshToken(payload.refresh_token || payload.refreshToken || credentials.refresh_token || credentials.refreshToken || (existingTokens && existingTokens.refresh_token));
  const idToken = String(payload.id_token || payload.idToken || credentials.id_token || credentials.idToken || (existingTokens && existingTokens.id_token) || '').trim();
  const upstreamAccountId = String(
    payload.chatgpt_account_id
    || payload.account_id
    || credentials.chatgpt_account_id
    || credentials.account_id
    || (existingTokens && existingTokens.account_id)
    || ''
  ).trim();
  if (!refreshToken) return null;

  const authJson = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      account_id: upstreamAccountId
    },
    last_refresh: String(payload.last_refresh || payload.lastRefresh || '').trim() || new Date().toISOString()
  };
  const email = extractOAuthEmail('codex', payload);
  if (email) authJson.email = email;
  return authJson;
}

function readAccountExportRecord({ provider, accountRef, aiHomeDir, fs }) {
  const p = normalizeProvider(provider);
  const envConfig = readAccountCredentials(fs, aiHomeDir, accountRef);
  const nativeAuth = readAccountNativeAuth(fs, aiHomeDir, accountRef);
  const base = {
    provider: p,
    accountRef,
    config: envConfig,
    auth: {},
    meta: {}
  };
  // 导出哪份原生凭据、带哪些元数据由凭据端口模块决定；没声明的 provider 只导出 env 配置。
  const strategy = getProviderCredentialStrategy(p);
  if (typeof strategy.exportRecord === 'function') {
    const exported = strategy.exportRecord(nativeAuth, EXPORT_HELPERS);
    base.auth = exported.auth;
    const credentialKind = resolveAccountExportCredentialKind({ ...base, meta: exported.kindMeta || exported.meta });
    base.meta = { ...exported.meta, credentialKind };
    return base;
  }
  base.meta.credentialKind = resolveAccountExportCredentialKind(base);
  return base;
}

function readTextFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf8') || '').trim();
  } catch (_error) {
    return '';
  }
}

function resolveAccountExportCredentialKind(record) {
  const provider = normalizeProvider(record && record.provider);
  if (!provider) return '';
  if (buildApiKeyIdentity(provider, record)) return 'api-key';
  const auth = record && record.auth && typeof record.auth === 'object' ? record.auth : {};
  // OAuth 类凭据可否导出由凭据端口模块判定；没声明的 provider 不导出 OAuth。
  const strategy = getProviderCredentialStrategy(provider);
  return typeof strategy.exportOAuthKind === 'function' ? strategy.exportOAuthKind(auth, record) : '';
}

function hasTransferableAccountRecord(record) {
  return Boolean(resolveAccountExportCredentialKind(record));
}

function looksLikeAiHomeAccountBundle(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.accounts)) return false;
  if (payload.version != null || payload.exportedAt || payload.kind === 'ai-home-accounts') return true;
  return payload.accounts.some((item) => {
    const account = item && typeof item === 'object' ? item : null;
    return Boolean(account && (account.provider || account.auth || account.config));
  });
}

function looksLikeAntigravityExportPayload(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.accounts)) return false;
  if (looksLikeAiHomeAccountBundle(payload)) return false;
  return payload.accounts.every((item) => looksLikeAntigravityAccountRecord(item));
}

function looksLikeAntigravityAccountRecord(value) {
  if (Array.isArray(value)) {
    return value.length >= 2
      && typeof value[0] === 'string'
      && typeof value[1] === 'string'
      && value[0].includes('@')
      && String(value[1] || '').trim();
  }
  const payload = value && typeof value === 'object' ? value : null;
  if (!payload) return false;
  if (payload.provider || payload.platform || payload.auth || payload.config || payload.credentials) return false;
  if (payload.access_token || payload.accessToken || payload.id_token || payload.idToken || payload.account_id || payload.chatgpt_account_id || payload.plan_type) return false;
  return Boolean(
    String(payload.email || '').trim().includes('@')
    && String(payload.refresh_token || payload.refreshToken || '').trim()
  );
}

function normalizeAntigravityAccountRecord(value) {
  if (Array.isArray(value)) {
    return {
      provider: 'agy',
      email: String(value[0] || '').trim().toLowerCase(),
      auth_method: AGY_CLI_AUTH_METHOD,
      token: {
        refresh_token: String(value[1] || '').trim()
      }
    };
  }
  const payload = value && typeof value === 'object' ? value : {};
  return {
    provider: 'agy',
    email: String(payload.email || '').trim().toLowerCase(),
    auth_method: String(payload.auth_method || payload.authMethod || '').trim() || AGY_CLI_AUTH_METHOD,
    token: {
      refresh_token: String(payload.refresh_token || payload.refreshToken || '').trim()
    }
  };
}

function looksLikeSub2ApiBundle(payload) {
  const source = payload && typeof payload === 'object' ? payload : null;
  if (!source || !Array.isArray(source.accounts)) return false;
  const type = normalizeCredentialType(source.type);
  if (type && type !== 'sub2api-data' && type !== 'sub2api-bundle') return false;
  if (!type && !Array.isArray(source.proxies)) return false;
  if (source.accounts.length === 0) return true;
  return source.accounts.every((item) => looksLikeSub2ApiAccountRecord(item));
}

function looksLikeSub2ApiAccountRecord(value) {
  const payload = value && typeof value === 'object' ? value : null;
  return Boolean(
    payload
    && !Array.isArray(payload)
    && payload.credentials
    && typeof payload.credentials === 'object'
    && firstNonEmptyString(payload.provider, payload.platform, payload.channel, payload.service, payload.credentials.provider, payload.credentials.platform)
    && normalizeCredentialType(payload.type)
  );
}

function looksLikeCliproxyapiDataBundle(payload) {
  const source = payload && typeof payload === 'object' ? payload : null;
  if (!source || !Array.isArray(source.accounts)) return false;
  const type = normalizeCredentialType(source.type);
  if (type !== CLIPROXYAPI_DATA_TYPE) return false;
  if (source.accounts.length === 0) return true;
  return source.accounts.every((item) => looksLikeCliproxyapiDataAccountRecord(item));
}

function looksLikeCliproxyapiDataAccountRecord(value) {
  const payload = value && typeof value === 'object' ? value : null;
  if (!payload || Array.isArray(payload)) return false;
  const provider = normalizeImportProviderAlias(payload.provider || payload.platform || payload.channel || payload.service);
  const type = normalizeCredentialType(payload.type);
  if (!provider || (type && type !== 'oauth' && type !== 'api-key')) return false;
  return Boolean(type || payload.auth || payload.config || payload.cliproxyapi);
}

function hasOwnField(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function cloneTransferValue(value) {
  if (Array.isArray(value)) return value.map(cloneTransferValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneTransferValue(item)]));
  }
  return value;
}

function collectSub2ApiProxies(proxies) {
  if (!Array.isArray(proxies)) return [];
  return proxies
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map(cloneTransferValue);
}

function normalizeCliproxyapiDataAccountRecord(account) {
  const payload = account && typeof account === 'object' ? account : null;
  if (!payload || Array.isArray(payload)) return null;
  const provider = normalizeImportProviderAlias(payload.provider || payload.platform || payload.channel || payload.service);
  if (!provider) return null;
  const record = cloneTransferValue(payload);
  record.provider = provider;
  const type = normalizeCredentialType(payload.type);
  if (type) record.type = type;
  return record;
}

function attachSub2ApiMetadata(record, account, source = {}) {
  const metadata = {};
  const name = firstNonEmptyString(account.name, account.display_name);
  if (name) metadata.name = name;
  if (account.extra && typeof account.extra === 'object' && !Array.isArray(account.extra)) {
    metadata.extra = cloneTransferValue(account.extra);
  }
  SUB2API_ACCOUNT_METADATA_FIELDS.forEach((key) => {
    if (hasOwnField(account, key)) metadata[key] = cloneTransferValue(account[key]);
  });
  const proxies = collectSub2ApiProxies(source.proxies);
  if (proxies.length > 0) metadata.proxies = proxies;
  if (Object.keys(metadata).length === 0) return record;
  Object.defineProperty(record, SUB2API_RECORD_METADATA_KEY, {
    value: metadata,
    enumerable: false,
    configurable: true
  });
  return record;
}

function normalizeSub2ApiAccountRecord(account, source = {}) {
  const payload = account && typeof account === 'object' ? account : null;
  if (!payload) return null;
  const credentials = payload.credentials && typeof payload.credentials === 'object' ? payload.credentials : {};
  const extra = payload.extra && typeof payload.extra === 'object' ? payload.extra : {};
  const provider = normalizeImportProviderAlias(
    payload.provider
    || payload.platform
    || payload.channel
    || payload.service
    || credentials.provider
    || credentials.platform
  );
  if (!provider) return null;

  const record = {
    provider,
    name: firstNonEmptyString(payload.name, payload.display_name),
    type: payload.type,
    credentials,
    extra
  };

  if (provider === 'codex') {
    record.email = normalizeEmail(firstNonEmptyString(payload.email, credentials.email, extra.email));
    record.access_token = firstNonEmptyString(credentials.access_token, payload.access_token);
    record.refresh_token = firstNonEmptyString(credentials.refresh_token, payload.refresh_token);
    record.id_token = firstNonEmptyString(credentials.id_token, payload.id_token);
    record.chatgpt_account_id = firstNonEmptyString(credentials.chatgpt_account_id, payload.chatgpt_account_id);
    record.plan_type = firstNonEmptyString(credentials.plan_type, payload.plan_type);
  } else if (provider === 'agy') {
    record.email = normalizeEmail(firstNonEmptyString(payload.email, credentials.email, extra.email));
    record.auth_method = firstNonEmptyString(
      credentials.auth_method, credentials.authMethod,
      payload.auth_method, payload.authMethod
    ) || AGY_CLI_AUTH_METHOD;
    record.token = {
      access_token: firstNonEmptyString(credentials.access_token, payload.access_token),
      refresh_token: firstNonEmptyString(credentials.refresh_token, payload.refresh_token),
      expiry: firstNonEmptyString(credentials.expires_at, credentials.expiry, payload.expires_at)
    };
  } else if (provider === 'gemini') {
    record.email = normalizeEmail(firstNonEmptyString(payload.email, credentials.email, extra.email));
    record.access_token = firstNonEmptyString(credentials.access_token, payload.access_token);
    record.refresh_token = firstNonEmptyString(credentials.refresh_token, payload.refresh_token);
    record.id_token = firstNonEmptyString(credentials.id_token, payload.id_token);
    record.client_id = firstNonEmptyString(credentials.client_id, payload.client_id);
  } else if (provider === 'claude') {
    record.email = normalizeEmail(firstNonEmptyString(payload.email, credentials.email, extra.email));
    record.claudeAiOauth = credentials.claudeAiOauth || credentials.claude_ai_oauth || payload.claudeAiOauth || payload.claude_ai_oauth || credentials;
  } else if (provider === 'grok') {
    record.email = normalizeEmail(firstNonEmptyString(payload.email, credentials.email, extra.email));
    record.access_token = firstNonEmptyString(credentials.access_token, payload.access_token);
    record.refresh_token = firstNonEmptyString(credentials.refresh_token, payload.refresh_token);
  } else {
    record.email = normalizeEmail(firstNonEmptyString(payload.email, credentials.email, extra.email));
  }

  const apiKeyConfig = extractApiKeyConfig(provider, { ...payload, credentials });
  if (apiKeyConfig.apiKey) {
    record.config = provider === 'codex'
      ? {
          OPENAI_API_KEY: apiKeyConfig.apiKey,
          ...(apiKeyConfig.baseUrl ? { OPENAI_BASE_URL: apiKeyConfig.baseUrl } : {})
        }
      : provider === 'grok'
        ? {
            XAI_API_KEY: apiKeyConfig.apiKey,
            ...(apiKeyConfig.baseUrl ? { XAI_BASE_URL: apiKeyConfig.baseUrl } : {})
          }
        : { apiKey: apiKeyConfig.apiKey, baseUrl: apiKeyConfig.baseUrl };
  }

  return attachSub2ApiMetadata(record, payload, source);
}

function flattenImportRecords(value) {
  const out = [];
  const visit = (item) => {
    if (Array.isArray(item)) {
      if (looksLikeAntigravityAccountRecord(item)) {
        out.push(normalizeAntigravityAccountRecord(item));
        return;
      }
      item.forEach(visit);
      return;
    }
    const payload = item && typeof item === 'object' ? item : null;
    if (!payload) return;
    if (looksLikeCliproxyapiDataBundle(payload)) {
      payload.accounts
        .map(normalizeCliproxyapiDataAccountRecord)
        .filter(Boolean)
        .forEach(visit);
      return;
    }
    if (looksLikeSub2ApiBundle(payload)) {
      payload.accounts
        .map((account) => normalizeSub2ApiAccountRecord(account, { proxies: payload.proxies }))
        .filter(Boolean)
        .forEach(visit);
      return;
    }
    if (looksLikeAntigravityExportPayload(payload)) {
      payload.accounts.map(normalizeAntigravityAccountRecord).forEach(visit);
      return;
    }
    if (looksLikeAiHomeAccountBundle(payload)) {
      payload.accounts.forEach(visit);
      return;
    }
    if (looksLikeAntigravityAccountRecord(payload)) {
      out.push(normalizeAntigravityAccountRecord(payload));
      return;
    }
    out.push(payload);
  };
  visit(value);
  return out;
}

function parseManualImportText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  try {
    return flattenImportRecords(JSON.parse(raw));
  } catch (_error) {}
  return raw
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => flattenImportRecords(JSON.parse(line)));
}

function extractImportRecords(payload) {
  const input = payload && typeof payload === 'object' ? payload : null;
  if (!input) return null;
  if (looksLikeCliproxyapiDataBundle(input) || looksLikeSub2ApiBundle(input) || looksLikeAntigravityExportPayload(input) || looksLikeAiHomeAccountBundle(input)) {
    return flattenImportRecords(input);
  }
  if (Array.isArray(input.accounts)) return flattenImportRecords(input.accounts);
  if (input.account && typeof input.account === 'object') return flattenImportRecords(input.account);
  if (typeof input.content === 'string' && input.content.trim()) return parseManualImportText(input.content);
  return null;
}

function inferImportProvider(record) {
  const payload = record && typeof record === 'object' ? record : null;
  if (!payload) return '';
  const provider = normalizeImportProviderAlias(payload.provider || payload.platform || payload.channel || payload.service);
  if (provider) return provider;
  const typeProvider = normalizeImportProviderAlias(payload.type);
  if (typeProvider) return typeProvider;
  const credentials = payload.credentials && typeof payload.credentials === 'object' ? payload.credentials : null;
  const credentialProvider = normalizeImportProviderAlias(credentials && (credentials.provider || credentials.platform));
  if (credentialProvider) return credentialProvider;
  const credentialType = normalizeCredentialType(payload.type);
  if (
    credentialType === 'oauth'
    && payload.email
    && (payload.token || payload.refresh_token || payload.refreshToken)
    && !payload.chatgpt_account_id
    && !payload.plan_type
  ) {
    return 'agy';
  }
  if (provider) return provider;
  const auth = payload.auth && typeof payload.auth === 'object' ? payload.auth : null;
  const tokens = payload.tokens && typeof payload.tokens === 'object'
    ? payload.tokens
    : (auth && auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : null);
  if (payload.refresh_token || payload.chatgpt_account_id || payload.plan_type || (tokens && tokens.refresh_token)) return 'codex';
  if (payload.claudeAiOauth || payload.claude_ai_oauth || (auth && (auth.claudeAiOauth || auth.claude_ai_oauth))) return 'claude';
  const agyToken = payload.token && typeof payload.token === 'object' ? payload.token : null;
  const nestedAgyToken = auth && auth.token && typeof auth.token === 'object' ? auth.token : null;
  if (
    payload.auth_method
    || (auth && auth.auth_method)
    || (agyToken && (agyToken.access_token || agyToken.refresh_token))
    || (nestedAgyToken && (nestedAgyToken.access_token || nestedAgyToken.refresh_token))
  ) {
    return 'agy';
  }
  if (buildApiKeyIdentity('codex', payload)) return 'codex';
  if (buildApiKeyIdentity('claude', payload)) return 'claude';
  if (buildApiKeyIdentity('gemini', payload)) return 'gemini';
  if ((payload.client_id && payload.access_token && !payload.chatgpt_account_id)
    || (auth && auth.client_id && auth.access_token && !auth.chatgpt_account_id)) {
    return 'gemini';
  }
  return '';
}

function toEpochMs(value) {
  const text = String(value || '').trim();
  if (!text) return -1;
  const epochMs = Date.parse(text);
  return Number.isFinite(epochMs) && epochMs > 0 ? epochMs : -1;
}

function extractCredentialQuality(payload) {
  if (!payload || typeof payload !== 'object') {
    return { expiresAtMs: -1, lastRefreshMs: -1, hasAccessToken: 0, hasIdToken: 0 };
  }
  return {
    expiresAtMs: toEpochMs(payload.expired),
    lastRefreshMs: toEpochMs(payload.last_refresh),
    hasAccessToken: String(payload.access_token || '').trim() ? 1 : 0,
    hasIdToken: String(payload.id_token || '').trim() ? 1 : 0
  };
}

function compareCredentialQuality(left, right) {
  const leftQuality = extractCredentialQuality(left);
  const rightQuality = extractCredentialQuality(right);
  if (leftQuality.expiresAtMs !== rightQuality.expiresAtMs) return leftQuality.expiresAtMs - rightQuality.expiresAtMs;
  if (leftQuality.lastRefreshMs !== rightQuality.lastRefreshMs) return leftQuality.lastRefreshMs - rightQuality.lastRefreshMs;
  if (leftQuality.hasAccessToken !== rightQuality.hasAccessToken) return leftQuality.hasAccessToken - rightQuality.hasAccessToken;
  if (leftQuality.hasIdToken !== rightQuality.hasIdToken) return leftQuality.hasIdToken - rightQuality.hasIdToken;
  return 0;
}

function toIsoFromUnixSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  return new Date(seconds * 1000).toISOString();
}

function extractExpireIso(idToken, accessToken) {
  const accessPayload = decodeJwtPayloadUnsafe(accessToken);
  if (accessPayload && accessPayload.exp) return toIsoFromUnixSeconds(accessPayload.exp);
  const idPayload = decodeJwtPayloadUnsafe(idToken);
  if (idPayload && idPayload.exp) return toIsoFromUnixSeconds(idPayload.exp);
  return '';
}

function buildCliproxyapiCodexAuth(authJson) {
  if (!authJson || typeof authJson !== 'object') return null;
  const tokens = authJson.tokens && typeof authJson.tokens === 'object' ? authJson.tokens : null;
  if (!tokens) return null;
  const refreshToken = normalizeCodexRefreshToken(tokens.refresh_token);
  if (!refreshToken) return null;
  const idToken = String(tokens.id_token || '').trim();
  const accessToken = String(tokens.access_token || '').trim();
  const email = extractOAuthEmail('codex', authJson);
  if (!email) return null;
  const payload = {
    type: 'codex',
    email,
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: String(tokens.account_id || '').trim(),
    last_refresh: String(authJson.last_refresh || '').trim() || new Date().toISOString()
  };
  const expired = extractExpireIso(idToken, accessToken);
  if (expired) payload.expired = expired;
  return payload;
}

function buildAiHomeCodexAuthFromCliproxyapi(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const refreshToken = normalizeCodexRefreshToken(payload.refresh_token);
  if (!refreshToken) return null;
  const idToken = String(payload.id_token || '').trim();
  const accessToken = String(payload.access_token || '').trim();
  const email = extractOAuthEmail('codex', payload);
  if (!email) return null;
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    email,
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: String(payload.account_id || '').trim()
    },
    last_refresh: String(payload.last_refresh || '').trim() || new Date().toISOString()
  };
}

function isCodexAuthPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (normalizeProvider(payload.type) === 'codex') return true;
  return Boolean(normalizeCodexRefreshToken(payload.refresh_token));
}

function sanitizeEmailFileStem(email) {
  return String(email || '')
    .trim()
    .toLowerCase()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '');
}

function buildCanonicalFileName(payload) {
  const emailStem = sanitizeEmailFileStem(payload && payload.email);
  return emailStem ? `${emailStem}.json` : '';
}

module.exports = {
  SUB2API_RECORD_METADATA_KEY,
  normalizeProvider,
  normalizeBaseUrl,
  extractOAuthEmail,
  buildOAuthIdentity,
  extractApiKeyConfig,
  buildApiKeyIdentity,
  normalizeCodexAuthPayload,
  readAccountExportRecord,
  hasTransferableAccountRecord,
  parseManualImportText,
  flattenImportRecords,
  extractImportRecords,
  inferImportProvider,
  compareCredentialQuality,
  buildCliproxyapiCodexAuth,
  buildAiHomeCodexAuthFromCliproxyapi,
  isCodexAuthPayload,
  buildCanonicalFileName,
  normalizeAntigravityAccountRecord,
  normalizeImportProviderAlias,
  normalizeSub2ApiAccountRecord
};
