'use strict';

const {
  buildApiKeyIdentity,
  buildOAuthIdentity,
  extractApiKeyConfig,
  extractOAuthEmail,
  flattenImportRecords,
  inferImportProvider,
  normalizeBaseUrl,
  normalizeCodexAuthPayload,
  readAccountExportRecord,
  SUB2API_RECORD_METADATA_KEY
} = require('./transfer-core');
const {
  buildOpenCodeIdentitySeed,
  normalizeIdentitySeed
} = require('./account-identity');
const { writeClaudeCredentialEnv } = require('./claude-credential');
const { ACCOUNT_REF_PREFIX, isAccountRef } = require('./public-account-ref');
const { AGY_CLI_AUTH_METHOD } = require('./agy-auth-metadata');
const { registerAccountIdentity } = require('./account-registration');
const {
  listAccountCredentialRecords,
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../server/account-credential-store');
const {
  getPublicAccountRef,
  resolveAccountRef
} = require('../server/account-ref-store');
const {
  readTransferMetadata: readStoredTransferMetadata,
  writeTransferMetadata: writeStoredTransferMetadata
} = require('./transfer-metadata-store');

const SUPPORTED_STANDARD_PROVIDERS = Object.freeze(['codex', 'gemini', 'claude', 'agy', 'opencode', 'grok', 'qoder', 'qodercn']);
const SUPPORTED_API_KEY_PROVIDERS = Object.freeze(['codex', 'gemini', 'claude', 'grok']);
const SUB2API_DATA_TYPE = 'sub2api-data';
const SUB2API_DATA_VERSION = 1;
const SUB2API_METADATA_FIELDS = Object.freeze([
  'name',
  'notes',
  'proxy_key',
  'concurrency',
  'priority',
  'rate_multiplier',
  'expires_at',
  'auto_pause_on_expired'
]);
const SUB2API_PROXY_FALLBACK_MODES = new Set(['none', 'direct', 'proxy']);

function readJsonFileSafe(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function readTextFileSafe(fs, filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf8') || '').trim();
  } catch (_error) {
    return '';
  }
}

function writeJsonFile(fs, path, filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mergePlainObjects(left, right) {
  const out = { ...left };
  Object.entries(right || {}).forEach(([key, value]) => {
    out[key] = isPlainObject(value) && isPlainObject(out[key])
      ? mergePlainObjects(out[key], value)
      : value;
  });
  return out;
}

function readTransferMetadata({ fs, aiHomeDir, accountRef }) {
  return readStoredTransferMetadata(fs, aiHomeDir, accountRef);
}

function writeTransferMetadata({ fs, aiHomeDir, accountRef, patch }) {
  const existing = readTransferMetadata({ fs, aiHomeDir, accountRef });
  const existingFormats = isPlainObject(existing.formats) ? existing.formats : {};
  const patchFormats = isPlainObject(patch && patch.formats) ? patch.formats : {};
  const next = {
    ...existing,
    version: 1,
    formats: mergePlainObjects(existingFormats, patchFormats)
  };
  if (Object.keys(next.formats).length === 0) return;
  writeStoredTransferMetadata(fs, aiHomeDir, accountRef, next);
}

function readFormatMetadata({ fs, aiHomeDir, accountRef, format }) {
  const metadata = readTransferMetadata({ fs, aiHomeDir, accountRef });
  const formats = isPlainObject(metadata.formats) ? metadata.formats : {};
  const formatMetadata = formats[format];
  return isPlainObject(formatMetadata) ? formatMetadata : {};
}

function hasOwnField(source, key) {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function cloneTransferValue(value) {
  if (Array.isArray(value)) return value.map(cloneTransferValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneTransferValue(item)]));
  }
  return value;
}

function cleanTransferMetadata(value) {
  if (Array.isArray(value)) {
    return value
      .map(cleanTransferMetadata)
      .filter((item) => item != null)
      .filter((item) => !(typeof item === 'string' && item === ''))
      .filter((item) => !(Array.isArray(item) && item.length === 0))
      .filter((item) => !(isPlainObject(item) && Object.keys(item).length === 0));
  }
  if (isPlainObject(value)) {
    const out = {};
    Object.entries(value).forEach(([key, item]) => {
      const next = cleanTransferMetadata(item);
      if (next == null) return;
      if (typeof next === 'string' && next === '') return;
      if (Array.isArray(next) && next.length === 0) return;
      if (isPlainObject(next) && Object.keys(next).length === 0) return;
      out[key] = next;
    });
    return out;
  }
  return typeof value === 'string' ? value.trim() : value;
}

function listProviderAccounts({ fs, aiHomeDir, provider }) {
  return listAccountCredentialRecords(fs, aiHomeDir, provider);
}

function normalizeProviders(providers) {
  const requested = Array.isArray(providers) && providers.length > 0
    ? providers
    : SUPPORTED_STANDARD_PROVIDERS;
  return Array.from(new Set(requested
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item) => SUPPORTED_STANDARD_PROVIDERS.includes(item))));
}

function buildSub2ApiPlatform(provider) {
  if (provider === 'codex') return 'openai';
  if (provider === 'claude') return 'anthropic';
  if (provider === 'gemini') return 'gemini';
  if (provider === 'agy') return 'antigravity';
  if (provider === 'grok') return 'xai';
  return provider;
}

function readSub2ApiMetadata(record) {
  if (!record || !record.fs || !record.aiHomeDir || !record.accountRef) return {};
  return readFormatMetadata({
    fs: record.fs,
    aiHomeDir: record.aiHomeDir,
    accountRef: record.accountRef,
    format: 'sub2api'
  });
}

function buildSub2ApiName(record) {
  const metadata = readSub2ApiMetadata(record);
  const metadataName = String(metadata.name || '').trim();
  if (metadataName) return metadataName;
  const email = extractOAuthEmail(record.provider, record.auth);
  if (email) return `${record.provider}-${email}`;
  const apiKeyConfig = extractApiKeyConfig(record.provider, record);
  const baseUrl = apiKeyConfig.baseUrl || '';
  if (baseUrl) return `${record.provider}-${baseUrl}`;
  return `${record.provider}-account`;
}

function collectExportRecords({ fs, path, aiHomeDir, providers }) {
  const out = [];
  normalizeProviders(providers).forEach((provider) => {
    const accounts = listProviderAccounts({ fs, aiHomeDir, provider });
    accounts.forEach(({ accountRef }) => {
      const record = readAccountExportRecord({
        provider,
        accountRef,
        aiHomeDir,
        fs
      });
      const credentialKind = record && record.meta && record.meta.credentialKind;
      if (!credentialKind) return;
      out.push({ fs, path, aiHomeDir, provider, accountRef, ...record });
    });
  });
  return out;
}

function buildSub2ApiCredentials(record) {
  const provider = String(record && record.provider || '').trim().toLowerCase();
  const auth = record && record.auth && typeof record.auth === 'object' ? record.auth : {};
  const credentialKind = record && record.meta && record.meta.credentialKind;
  if (credentialKind === 'api-key') {
    const config = extractApiKeyConfig(provider, record);
    const credentials = {};
    if (config.apiKey) credentials.api_key = config.apiKey;
    if (config.baseUrl) credentials.base_url = config.baseUrl;
    return credentials;
  }
  if (provider === 'codex') {
    const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {};
    const credentials = {
      access_token: String(tokens.access_token || '').trim(),
      refresh_token: String(tokens.refresh_token || '').trim(),
      id_token: String(tokens.id_token || '').trim(),
      chatgpt_account_id: String(tokens.account_id || '').trim()
    };
    if (record.meta && record.meta.planType) credentials.plan_type = record.meta.planType;
    const email = extractOAuthEmail(provider, auth);
    if (email) credentials.email = email;
    return removeEmptyValues(credentials);
  }
  if (provider === 'gemini') {
    return removeEmptyValues({
      access_token: auth.access_token,
      refresh_token: auth.refresh_token,
      id_token: auth.id_token,
      client_id: auth.client_id,
      email: extractOAuthEmail(provider, auth)
    });
  }
  if (provider === 'claude') {
    const oauth = auth.claudeAiOauth || auth.claude_ai_oauth || auth;
    return removeEmptyValues({
      ...oauth,
      email: extractOAuthEmail(provider, auth)
    });
  }
  if (provider === 'agy') {
    const token = auth.token && typeof auth.token === 'object' ? auth.token : {};
    return removeEmptyValues({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: token.expiry,
      email: extractOAuthEmail(provider, auth) || (record.meta && record.meta.email)
    });
  }
  if (provider === 'opencode') {
    return auth;
  }
  return {};
}

function removeEmptyValues(input) {
  const out = {};
  Object.entries(input || {}).forEach(([key, value]) => {
    if (value == null) return;
    const next = typeof value === 'string' ? value.trim() : value;
    if (next === '') return;
    if (Array.isArray(next) && next.length === 0) return;
    if (isPlainObject(next) && Object.keys(next).length === 0) return;
    out[key] = next;
  });
  return out;
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function readNestedObject(source, key) {
  const value = source && source[key];
  return isPlainObject(value) ? value : {};
}

function normalizeGeminiOAuthAuth(account) {
  const payload = isPlainObject(account) ? account : {};
  const auth = readNestedObject(payload, 'auth');
  const credentials = readNestedObject(payload, 'credentials');
  const authCredentials = readNestedObject(auth, 'credentials');
  const email = extractOAuthEmail('gemini', payload);
  const expiry = firstNonEmptyString(
    auth.expiry,
    auth.expires_at,
    auth.expiry_date,
    payload.expiry,
    payload.expires_at,
    payload.expiry_date,
    credentials.expiry,
    credentials.expires_at,
    credentials.expiry_date,
    authCredentials.expiry,
    authCredentials.expires_at,
    authCredentials.expiry_date
  );
  const out = removeEmptyValues({
    access_token: firstNonEmptyString(
      auth.access_token,
      auth.accessToken,
      payload.access_token,
      payload.accessToken,
      credentials.access_token,
      credentials.accessToken,
      authCredentials.access_token,
      authCredentials.accessToken
    ),
    refresh_token: firstNonEmptyString(
      auth.refresh_token,
      auth.refreshToken,
      payload.refresh_token,
      payload.refreshToken,
      credentials.refresh_token,
      credentials.refreshToken,
      authCredentials.refresh_token,
      authCredentials.refreshToken
    ),
    id_token: firstNonEmptyString(
      auth.id_token,
      auth.idToken,
      payload.id_token,
      payload.idToken,
      credentials.id_token,
      credentials.idToken,
      authCredentials.id_token,
      authCredentials.idToken
    ),
    client_id: firstNonEmptyString(
      auth.client_id,
      auth.clientId,
      payload.client_id,
      payload.clientId,
      credentials.client_id,
      credentials.clientId,
      authCredentials.client_id,
      authCredentials.clientId
    ),
    email
  });
  if (expiry) out.expiry = expiry;
  const epoch = Number(expiry);
  if (Number.isFinite(epoch) && epoch > 0) {
    out.expires_at = epoch;
    out.expiry_date = epoch;
  }
  return out;
}

function normalizeAgyOAuthAuth(account) {
  const payload = isPlainObject(account) ? account : {};
  const auth = readNestedObject(payload, 'auth');
  const credentials = readNestedObject(payload, 'credentials');
  const token = isPlainObject(auth.token)
    ? auth.token
    : (isPlainObject(payload.token) ? payload.token : {});
  const email = extractOAuthEmail('agy', payload);
  return removeEmptyValues({
    auth_method: firstNonEmptyString(
      auth.auth_method,
      auth.authMethod,
      payload.auth_method,
      payload.authMethod,
      credentials.auth_method,
      credentials.authMethod
    ) || AGY_CLI_AUTH_METHOD,
    token: removeEmptyValues({
      access_token: firstNonEmptyString(
        token.access_token,
        token.accessToken,
        auth.access_token,
        auth.accessToken,
        payload.access_token,
        payload.accessToken,
        credentials.access_token,
        credentials.accessToken
      ),
      refresh_token: firstNonEmptyString(
        token.refresh_token,
        token.refreshToken,
        auth.refresh_token,
        auth.refreshToken,
        payload.refresh_token,
        payload.refreshToken,
        credentials.refresh_token,
        credentials.refreshToken
      ),
      expiry: firstNonEmptyString(
        token.expiry,
        token.expires_at,
        token.expiry_date,
        auth.expiry,
        auth.expires_at,
        auth.expiry_date,
        payload.expiry,
        payload.expires_at,
        payload.expiry_date,
        credentials.expiry,
        credentials.expires_at,
        credentials.expiry_date
      )
    }),
    email
  });
}

function buildSub2ApiExtra(record, metadata) {
  const metadataExtra = isPlainObject(metadata.extra) ? metadata.extra : {};
  return removeEmptyValues(sanitizeSub2ApiExtra(metadataExtra));
}

function sanitizeSub2ApiExtra(extra) {
  const out = { ...extra };
  [
    'ai_home_provider',
    'ai_home_account_id',
    'profileDir',
    'configDir',
    'profile_dir',
    'config_dir'
  ].forEach((key) => {
    delete out[key];
  });
  return out;
}

function buildSub2ApiAccount(record) {
  const credentialKind = record && record.meta && record.meta.credentialKind;
  const metadata = readSub2ApiMetadata(record);
  const account = {
    name: buildSub2ApiName(record),
    platform: buildSub2ApiPlatform(record.provider),
    type: credentialKind === 'api-key' ? 'apikey' : 'oauth',
    credentials: buildSub2ApiCredentials(record),
    extra: buildSub2ApiExtra(record, metadata),
    concurrency: metadata.concurrency == null ? 0 : metadata.concurrency,
    priority: metadata.priority == null ? 0 : metadata.priority
  };
  ['notes', 'proxy_key', 'rate_multiplier', 'expires_at', 'auto_pause_on_expired'].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(metadata, key)) account[key] = metadata[key];
  });
  return removeEmptyValues(account);
}

function sanitizeExportFileStem(value, fallback = 'account') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return normalized || fallback;
}

function getAccountRefSuffix(accountRef) {
  const normalizedRef = String(accountRef || '').trim();
  return isAccountRef(normalizedRef) ? normalizedRef.slice(ACCOUNT_REF_PREFIX.length) : '';
}

function uniquifyFileName(fileName, accountRef, usedNames) {
  const safeName = String(fileName || '').trim() || 'account.json';
  const key = safeName.toLowerCase();
  if (!usedNames.has(key)) {
    usedNames.add(key);
    return safeName;
  }

  const suffix = getAccountRefSuffix(accountRef) || 'duplicate';
  const stem = safeName.replace(/\.json$/i, '');
  let candidate = `${stem}_${suffix}.json`;
  let counter = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${stem}_${suffix}_${counter}.json`;
    counter += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function buildFlatAccountExportFileName(record) {
  const provider = String(record && record.provider || '').trim().toLowerCase();
  const credentialKind = record && record.meta && record.meta.credentialKind;
  if (!provider || !credentialKind) return null;
  if (credentialKind !== 'oauth' && credentialKind !== 'api-key') return null;

  if (credentialKind === 'api-key') {
    const config = extractApiKeyConfig(provider, record);
    if (!buildApiKeyIdentity(provider, config)) return null;
    const urlStem = sanitizeExportFileStem(config.baseUrl || 'default', 'default');
    const suffix = getAccountRefSuffix(record.accountRef);
    if (!suffix) return null;
    return {
      fileName: `${provider}_${urlStem}_${suffix}.json`
    };
  }

  if (provider === 'opencode') {
    if (!buildOpenCodeIdentitySeed(record && record.auth)) return null;
    const suffix = getAccountRefSuffix(record.accountRef);
    if (!suffix) return null;
    return {
      fileName: `${provider}_auth_${suffix}.json`
    };
  }

  const email = extractOAuthEmail(provider, record && record.auth) || String(record && record.meta && record.meta.email || '').trim().toLowerCase();
  const authWithEmail = email && record && record.auth && typeof record.auth === 'object' && !record.auth.email
    ? { ...record.auth, email }
    : record && record.auth;
  if (!email || !buildOAuthIdentity(provider, authWithEmail)) return null;
  return {
    fileName: `${provider}_${sanitizeExportFileStem(email)}.json`
  };
}

function buildFlatAccountExportEntry({ fs, path, aiHomeDir, account }) {
  const source = account && typeof account === 'object' ? account : {};
  const provider = String(source.provider || '').trim().toLowerCase();
  const accountRef = String(source.accountRef || '').trim();
  if (!SUPPORTED_STANDARD_PROVIDERS.includes(provider)) {
    return { skipped: true, provider, accountRef, reason: 'unsupported_provider' };
  }
  if (!accountRef || !aiHomeDir) {
    return { skipped: true, provider, accountRef, reason: 'invalid_account_source' };
  }

  const record = readAccountExportRecord({
    provider,
    accountRef,
    aiHomeDir,
    fs
  });
  const credentialKind = record && record.meta && record.meta.credentialKind;
  if (!credentialKind) {
    return { skipped: true, provider, accountRef, reason: 'missing_credentials' };
  }

  const fileName = buildFlatAccountExportFileName({ fs, path, aiHomeDir, provider, accountRef, ...record });
  if (!fileName) {
    return { skipped: true, provider, accountRef, reason: 'missing_stable_identity' };
  }

  const payload = buildSub2ApiAccount({ fs, path, aiHomeDir, provider, accountRef, ...record });
  if (!payload.credentials || Object.keys(payload.credentials).length === 0) {
    return { skipped: true, provider, accountRef, reason: 'empty_credentials' };
  }

  return {
    provider,
    accountRef,
    fileName: fileName.fileName,
    payload
  };
}

function buildFlatAccountExportEntries({ fs, path, aiHomeDir, accounts }) {
  const usedNames = new Set();
  const entries = [];
  const skipped = [];
  (Array.isArray(accounts) ? accounts : []).forEach((account) => {
    const entry = buildFlatAccountExportEntry({ fs, path, aiHomeDir, account });
    if (!entry || entry.skipped) {
      skipped.push(entry || { skipped: true, reason: 'invalid_entry' });
      return;
    }
    entries.push({
      ...entry,
      fileName: uniquifyFileName(entry.fileName, entry.accountRef, usedNames)
    });
  });
  return { entries, skipped };
}

function collectSub2ApiProxies(records) {
  const proxiesByKey = new Map();
  records.forEach((record) => {
    const metadata = readSub2ApiMetadata(record);
    const proxies = Array.isArray(metadata.proxies) ? metadata.proxies : [];
    proxies.forEach((proxy) => {
      if (!isPlainObject(proxy)) return;
      const key = String(proxy.proxy_key || '').trim();
      if (!key || proxiesByKey.has(key)) return;
      proxiesByKey.set(key, normalizeSub2ApiProxy(proxy));
    });
  });
  return Array.from(proxiesByKey.values());
}

function normalizeSub2ApiProxy(proxy) {
  const out = removeEmptyValues(proxy);
  const fallbackMode = normalizeSub2ApiFallbackMode(proxy && proxy.fallback_mode);
  if (fallbackMode) out.fallback_mode = fallbackMode;
  else delete out.fallback_mode;
  const status = String(out.status || '').trim().toLowerCase();
  if (status === 'active' || status === 'inactive') out.status = status;
  else delete out.status;
  return out;
}

function normalizeSub2ApiFallbackMode(value) {
  if (value === false) return 'none';
  if (value === true) return '';
  const normalized = String(value || '').trim().toLowerCase();
  return SUB2API_PROXY_FALLBACK_MODES.has(normalized) ? normalized : '';
}

function buildSub2ApiExportPayload({ fs, path, aiHomeDir, providers = [] }) {
  const records = collectExportRecords({ fs, path, aiHomeDir, providers });
  const accounts = records
    .map(buildSub2ApiAccount)
    .filter((account) => account.credentials && Object.keys(account.credentials).length > 0);
  return {
    type: SUB2API_DATA_TYPE,
    version: SUB2API_DATA_VERSION,
    exported_at: new Date().toISOString(),
    proxies: collectSub2ApiProxies(records),
    accounts
  };
}

function buildAntigravityManagerExportPayload({ fs, path, aiHomeDir, providers = ['agy'] }) {
  const accounts = collectExportRecords({ fs, path, aiHomeDir, providers })
    .filter((record) => record.provider === 'agy' && record.meta && record.meta.credentialKind === 'oauth')
    .map((record) => {
      const token = record.auth && record.auth.token && typeof record.auth.token === 'object' ? record.auth.token : {};
      return {
        email: extractOAuthEmail('agy', record.auth) || (record.meta && record.meta.email) || '',
        refresh_token: String(token.refresh_token || '').trim()
      };
    })
    .filter((item) => item.refresh_token);
  return { accounts };
}

function buildStandardOAuthIdentity(provider, auth) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  if (normalizedProvider === 'opencode') return buildOpenCodeIdentitySeed(auth);
  return buildOAuthIdentity(normalizedProvider, auth);
}

function resolveIdentitySeed(provider, identityKind, identityPayload) {
  const rawIdentity = identityKind === 'api-key'
    ? buildApiKeyIdentity(provider, identityPayload)
    : buildStandardOAuthIdentity(provider, identityPayload);
  return normalizeIdentitySeed(rawIdentity);
}

function findExistingAccountByIdentity({ fs, aiHomeDir, provider, identityKind, identityPayload }) {
  const identitySeed = resolveIdentitySeed(provider, identityKind, identityPayload);
  if (!identitySeed) return null;
  return resolveAccountRef(
    fs,
    aiHomeDir,
    getPublicAccountRef(`unique:${identitySeed}`),
    { bestEffort: true }
  );
}

function notifyAuthArtifactsChanged(accountArtifactHooks, provider, accountRef, before, source, reason) {
  if (!before || !accountArtifactHooks || typeof accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged !== 'function') return;
  accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged({
    provider,
    accountRef,
    before,
    source,
    reason
  });
}

function snapshotAuthArtifacts(accountArtifactHooks, provider, accountRef) {
  return accountArtifactHooks && typeof accountArtifactHooks.snapshotAccountAuthArtifacts === 'function'
    ? accountArtifactHooks.snapshotAccountAuthArtifacts(provider, accountRef)
    : null;
}

function writeApiKeyAccount({ fs, aiHomeDir, provider, accountRef, config }) {
  if (!SUPPORTED_API_KEY_PROVIDERS.includes(provider)) {
    throw new Error(`Unsupported API-key provider: ${provider}`);
  }
  const env = {};
  if (provider === 'codex') {
    env.OPENAI_API_KEY = config.apiKey;
    if (config.baseUrl) env.OPENAI_BASE_URL = config.baseUrl;
  } else if (provider === 'claude') {
    Object.assign(env, writeClaudeCredentialEnv(env, {
      credentialType: config.credentialType || config.authType || 'api-key',
      token: config.apiKey,
      baseUrl: config.baseUrl
    }));
  } else if (provider === 'gemini') {
    env.GEMINI_API_KEY = config.apiKey;
    if (config.baseUrl) env.GEMINI_BASE_URL = config.baseUrl;
  }
  writeAccountCredentials(fs, aiHomeDir, accountRef, env);
}

function writeOAuthAccount({ fs, aiHomeDir, provider, accountRef, auth }) {
  let nativeAuth = null;
  if (provider === 'codex') nativeAuth = { auth };
  else if (provider === 'gemini') nativeAuth = { oauthCreds: auth };
  else if (provider === 'claude') nativeAuth = { credentials: auth };
  if (provider === 'agy') {
    const email = extractOAuthEmail(provider, auth);
    const authToWrite = { ...auth };
    delete authToWrite.email;
    nativeAuth = { oauthToken: authToWrite, ...(email ? { email } : {}) };
  }
  if (provider === 'opencode') nativeAuth = { auth };
  if (provider === 'qoder' || provider === 'qodercn') {
    // Import stores the decrypted user-info as a freshly encrypted blob so the
    // account projection matches the native CLI layout on next materialize.
    const { getQoderVariant, encryptQoderCredentials } = require('./qoder-auth-metadata');
    const crypto = require('node:crypto');
    const variant = getQoderVariant(provider);
    if (!variant) throw new Error(`Unsupported OAuth provider: ${provider}`);
    const salt = crypto.randomBytes(32);
    const saltB64 = salt.toString('base64');
    const encrypted = encryptQoderCredentials(auth, saltB64, variant.credentialPrefix);
    nativeAuth = {
      credentials: encrypted,
      keychainSalt: saltB64,
      userInfo: auth && typeof auth === 'object' ? auth : null
    };
  }
  if (!nativeAuth) throw new Error(`Unsupported OAuth provider: ${provider}`);
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, nativeAuth);
}

function buildSub2ApiMetadataPatch(account) {
  const metadata = account && account[SUB2API_RECORD_METADATA_KEY];
  if (!isPlainObject(metadata)) return null;
  const next = {};
  SUB2API_METADATA_FIELDS.forEach((key) => {
    if (hasOwnField(metadata, key)) next[key] = cloneTransferValue(metadata[key]);
  });
  if (isPlainObject(metadata.extra)) next.extra = cloneTransferValue(metadata.extra);
  if (Array.isArray(metadata.proxies)) next.proxies = cloneTransferValue(metadata.proxies);
  const cleaned = cleanTransferMetadata(next);
  if (!isPlainObject(cleaned) || Object.keys(cleaned).length === 0) return null;
  return { formats: { sub2api: cleaned } };
}

function writeSub2ApiMetadata({ fs, aiHomeDir, accountRef, account }) {
  const patch = buildSub2ApiMetadataPatch(account);
  if (!patch) return;
  writeTransferMetadata({
    fs,
    aiHomeDir,
    accountRef,
    patch
  });
}

function normalizeOAuthAuth(provider, account) {
  const rawAuth = account && account.auth && typeof account.auth === 'object'
    ? { ...account, ...account.auth }
    : account;
  if (provider === 'codex') return normalizeCodexAuthPayload(rawAuth);
  if (provider === 'gemini') {
    return normalizeGeminiOAuthAuth(account);
  }
  if (provider === 'claude') {
    const email = extractOAuthEmail(provider, account);
    const auth = account && account.auth && typeof account.auth === 'object' ? account.auth : account;
    return email && auth && !auth.email ? { ...auth, email } : auth;
  }
  if (provider === 'agy') {
    return normalizeAgyOAuthAuth(account);
  }
  if (provider === 'opencode') {
    const credentials = account && account.credentials && typeof account.credentials === 'object' ? account.credentials : null;
    if (credentials && Object.keys(credentials).length > 0) return credentials;
    const auth = account && account.auth && typeof account.auth === 'object' ? account.auth : null;
    if (auth && Object.keys(auth).length > 0) return auth;
    return account && typeof account === 'object' ? account : null;
  }
  return null;
}

function importStandardAccountRecords(options = {}) {
  const {
    fs,
    aiHomeDir,
    records,
    accountArtifactHooks,
    dryRun = false,
    source = 'standard_account_import'
  } = options;
  const summary = {
    total: Array.isArray(records) ? records.length : 0,
    imported: 0,
    duplicates: 0,
    invalid: 0,
    failed: 0,
    accounts: []
  };
  for (const account of (Array.isArray(records) ? records : [])) {
    try {
      const provider = inferImportProvider(account);
      if (!SUPPORTED_STANDARD_PROVIDERS.includes(provider)) {
        summary.invalid += 1;
        continue;
      }
      const apiKeyConfig = extractApiKeyConfig(provider, account);
      if (apiKeyConfig.apiKey) {
        if (!SUPPORTED_API_KEY_PROVIDERS.includes(provider)) {
          summary.invalid += 1;
          summary.accounts.push({ provider, accountRef: '', status: 'invalid', reason: 'unsupported_api_key_provider' });
          continue;
        }
        const identitySeed = resolveIdentitySeed(provider, 'api-key', apiKeyConfig);
        const existing = findExistingAccountByIdentity({
          fs,
          aiHomeDir,
          provider,
          identityKind: 'api-key',
          identityPayload: apiKeyConfig
        });
        if (existing) {
          summary.duplicates += 1;
          summary.accounts.push({ provider, accountRef: existing.accountRef, status: 'skipped', reason: 'duplicate_api_key' });
          continue;
        }
        const accountRef = dryRun
          ? getPublicAccountRef(`unique:${identitySeed}`)
          : registerAccountIdentity(fs, aiHomeDir, { provider, identitySeed }).accountRef;
        const before = dryRun ? null : snapshotAuthArtifacts(accountArtifactHooks, provider, accountRef);
        if (!dryRun) {
          writeApiKeyAccount({ fs, aiHomeDir, provider, accountRef, config: apiKeyConfig });
          writeSub2ApiMetadata({ fs, aiHomeDir, accountRef, account });
          notifyAuthArtifactsChanged(accountArtifactHooks, provider, accountRef, before, source, 'imported_credentials_updated');
        }
        summary.imported += 1;
        summary.accounts.push({ provider, accountRef, status: 'created', authMode: 'api-key' });
        continue;
      }

      const auth = normalizeOAuthAuth(provider, account);
      if (!auth || !buildStandardOAuthIdentity(provider, auth)) {
        summary.invalid += 1;
        continue;
      }
      const identitySeed = resolveIdentitySeed(provider, 'oauth', auth);
      const existing = findExistingAccountByIdentity({
        fs,
        aiHomeDir,
        provider,
        identityKind: 'oauth',
        identityPayload: auth
      });
      if (existing) {
        summary.duplicates += 1;
        summary.accounts.push({ provider, accountRef: existing.accountRef, status: 'skipped', reason: 'duplicate_oauth_identity' });
        continue;
      }
      const accountRef = dryRun
        ? getPublicAccountRef(`unique:${identitySeed}`)
        : registerAccountIdentity(fs, aiHomeDir, { provider, identitySeed }).accountRef;
      const before = dryRun ? null : snapshotAuthArtifacts(accountArtifactHooks, provider, accountRef);
      if (!dryRun) {
        writeOAuthAccount({ fs, aiHomeDir, provider, accountRef, auth });
        writeSub2ApiMetadata({ fs, aiHomeDir, accountRef, account });
        notifyAuthArtifactsChanged(accountArtifactHooks, provider, accountRef, before, source, 'imported_credentials_updated');
      }
      summary.imported += 1;
      summary.accounts.push({ provider, accountRef, status: 'created', authMode: 'oauth' });
    } catch (_error) {
      summary.failed += 1;
    }
  }
  return summary;
}

function parseStandardAccountRecordsFromJson(payload) {
  if (!payload || typeof payload !== 'object') return [];
  return flattenImportRecords(payload);
}

function normalizeSub2ApiCredentialType(type) {
  const normalized = String(type || '').trim().toLowerCase().replace(/[_\s-]+/g, '-');
  if (normalized === 'apikey') return 'api-key';
  return normalized;
}

function buildOpenAiBaseUrl(value) {
  return normalizeBaseUrl(value);
}

module.exports = {
  SUB2API_DATA_TYPE,
  SUB2API_DATA_VERSION,
  buildOpenAiBaseUrl,
  buildFlatAccountExportEntries,
  buildSub2ApiExportPayload,
  buildAntigravityManagerExportPayload,
  collectExportRecords,
  importStandardAccountRecords,
  normalizeSub2ApiCredentialType,
  parseStandardAccountRecordsFromJson,
  writeSub2ApiMetadata
};
