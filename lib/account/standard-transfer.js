'use strict';

const nodePath = require('node:path');

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
  buildIdentityFromStoredRecord
} = require('./account-identity');
const { writeClaudeCredentialEnv } = require('./claude-credential');
const { getPublicAccountRefSuffix } = require('./public-account-ref');

const SUPPORTED_STANDARD_PROVIDERS = Object.freeze(['codex', 'gemini', 'claude', 'agy']);
const SUPPORTED_API_KEY_PROVIDERS = Object.freeze(['codex', 'gemini', 'claude']);
const SUB2API_DATA_TYPE = 'sub2api-data';
const SUB2API_DATA_VERSION = 1;
const TRANSFER_METADATA_FILE = '.aih_transfer.json';
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

function readTransferMetadata({ fs, path, profileDir }) {
  const metadata = readJsonFileSafe(fs, path.join(profileDir, TRANSFER_METADATA_FILE));
  return isPlainObject(metadata) ? metadata : {};
}

function writeTransferMetadata({ fs, path, profileDir, patch }) {
  const existing = readTransferMetadata({ fs, path, profileDir });
  const existingFormats = isPlainObject(existing.formats) ? existing.formats : {};
  const patchFormats = isPlainObject(patch && patch.formats) ? patch.formats : {};
  const next = {
    ...existing,
    version: 1,
    formats: mergePlainObjects(existingFormats, patchFormats)
  };
  if (Object.keys(next.formats).length === 0) return;
  writeJsonFile(fs, path, path.join(profileDir, TRANSFER_METADATA_FILE), next);
}

function readFormatMetadata({ fs, path, profileDir, format }) {
  const metadata = readTransferMetadata({ fs, path, profileDir });
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

function isNumericAccountId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function nextAccountId(provider, getToolAccountIds) {
  const ids = getToolAccountIds(provider)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  return String((ids.length ? Math.max(...ids) : 0) + 1);
}

function claimNextAccountId({ fs, provider, getToolAccountIds, getProfileDir }) {
  let candidate = Number(nextAccountId(provider, getToolAccountIds));
  const firstProfileDir = getProfileDir(provider, String(candidate));
  fs.mkdirSync(nodePath.dirname(firstProfileDir), { recursive: true });
  while (true) {
    const accountId = String(candidate);
    const profileDir = getProfileDir(provider, accountId);
    try {
      fs.mkdirSync(profileDir);
      return accountId;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        candidate += 1;
        continue;
      }
      throw error;
    }
  }
}

function listProviderAccountIds({ fs, path, aiHomeDir, provider }) {
  const providerDir = path.join(aiHomeDir, 'profiles', provider);
  try {
    return fs.readdirSync(providerDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isNumericAccountId(entry.name))
      .map((entry) => String(entry.name))
      .sort((a, b) => Number(a) - Number(b));
  } catch (_error) {
    return [];
  }
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
  return provider;
}

function readSub2ApiMetadata(record) {
  if (!record || !record.fs || !record.path || !record.profileDir) return {};
  return readFormatMetadata({
    fs: record.fs,
    path: record.path,
    profileDir: record.profileDir,
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

function getProviderConfigDir(path, provider, profileDir) {
  if (provider === 'agy') return path.join(profileDir, '.gemini', 'antigravity-cli');
  return path.join(profileDir, `.${provider}`);
}

function collectExportRecords({ fs, path, aiHomeDir, providers }) {
  const out = [];
  normalizeProviders(providers).forEach((provider) => {
    const ids = listProviderAccountIds({ fs, path, aiHomeDir, provider });
    ids.forEach((accountId) => {
      const profileDir = path.join(aiHomeDir, 'profiles', provider, accountId);
      const configDir = getProviderConfigDir(path, provider, profileDir);
      const record = readAccountExportRecord({
        provider,
        accountId,
        profileDir,
        configDir,
        fs
      });
      const credentialKind = record && record.meta && record.meta.credentialKind;
      if (!credentialKind) return;
      out.push({ fs, path, provider, accountId, profileDir, configDir, ...record });
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

function uniquifyFileName(fileName, identityKey, usedNames) {
  const safeName = String(fileName || '').trim() || 'account.json';
  const key = safeName.toLowerCase();
  if (!usedNames.has(key)) {
    usedNames.add(key);
    return safeName;
  }

  const suffix = getPublicAccountRefSuffix(identityKey) || 'duplicate';
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
    const identityKey = buildApiKeyIdentity(provider, config);
    if (!identityKey) return null;
    const urlStem = sanitizeExportFileStem(config.baseUrl || 'default', 'default');
    const suffix = getPublicAccountRefSuffix(identityKey);
    if (!suffix) return null;
    return {
      fileName: `${provider}_${urlStem}_${suffix}.json`,
      identityKey
    };
  }

  const email = extractOAuthEmail(provider, record && record.auth) || String(record && record.meta && record.meta.email || '').trim().toLowerCase();
  const authWithEmail = email && record && record.auth && typeof record.auth === 'object' && !record.auth.email
    ? { ...record.auth, email }
    : record && record.auth;
  const identityKey = buildOAuthIdentity(provider, authWithEmail);
  if (!email || !identityKey) return null;
  return {
    fileName: `${provider}_${sanitizeExportFileStem(email)}.json`,
    identityKey
  };
}

function buildFlatAccountExportEntry({ fs, path, account }) {
  const source = account && typeof account === 'object' ? account : {};
  const provider = String(source.provider || '').trim().toLowerCase();
  const accountId = String(source.id || source.accountId || '').trim();
  if (!SUPPORTED_STANDARD_PROVIDERS.includes(provider)) {
    return { skipped: true, provider, accountId, reason: 'unsupported_provider' };
  }
  if (!accountId || !source.profileDir) {
    return { skipped: true, provider, accountId, reason: 'invalid_account_source' };
  }

  const profileDir = source.profileDir;
  const configDir = getProviderConfigDir(path, provider, profileDir);
  const record = readAccountExportRecord({
    provider,
    accountId,
    profileDir,
    configDir,
    fs
  });
  const credentialKind = record && record.meta && record.meta.credentialKind;
  if (!credentialKind) {
    return { skipped: true, provider, accountId, reason: 'missing_credentials' };
  }

  const fileName = buildFlatAccountExportFileName({ fs, path, provider, accountId, profileDir, configDir, ...record });
  if (!fileName) {
    return { skipped: true, provider, accountId, reason: 'missing_stable_identity' };
  }

  const payload = buildSub2ApiAccount({ fs, path, provider, accountId, profileDir, configDir, ...record });
  if (!payload.credentials || Object.keys(payload.credentials).length === 0) {
    return { skipped: true, provider, accountId, reason: 'empty_credentials' };
  }

  return {
    provider,
    accountId,
    fileName: fileName.fileName,
    identityKey: fileName.identityKey,
    payload
  };
}

function buildFlatAccountExportEntries({ fs, path, accounts }) {
  const usedNames = new Set();
  const entries = [];
  const skipped = [];
  (Array.isArray(accounts) ? accounts : []).forEach((account) => {
    const entry = buildFlatAccountExportEntry({ fs, path, account });
    if (!entry || entry.skipped) {
      skipped.push(entry || { skipped: true, reason: 'invalid_entry' });
      return;
    }
    entries.push({
      ...entry,
      fileName: uniquifyFileName(entry.fileName, entry.identityKey, usedNames)
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

function findExistingAccountByIdentity({ fs, path, provider, identityKind, identityPayload, getToolAccountIds, getProfileDir, getToolConfigDir }) {
  const incoming = identityKind === 'api-key'
    ? buildApiKeyIdentity(provider, identityPayload)
    : buildOAuthIdentity(provider, identityPayload);
  if (!incoming) return '';
  for (const accountId of getToolAccountIds(provider)) {
    const existing = buildIdentityFromStoredRecord({
      fs,
      path,
      provider,
      accountId,
      getProfileDir,
      getToolConfigDir,
      identityKind
    });
    if (existing === incoming) return String(accountId);
  }
  return '';
}

function notifyAuthArtifactsChanged(accountArtifactHooks, provider, accountId, before, source, reason) {
  if (!before || !accountArtifactHooks || typeof accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged !== 'function') return;
  accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged({
    provider,
    accountId,
    before,
    source,
    reason
  });
}

function snapshotAuthArtifacts(accountArtifactHooks, provider, accountId) {
  return accountArtifactHooks && typeof accountArtifactHooks.snapshotAccountAuthArtifacts === 'function'
    ? accountArtifactHooks.snapshotAccountAuthArtifacts(provider, accountId)
    : null;
}

function writeApiKeyAccount({ fs, path, provider, accountId, config, getProfileDir, getToolConfigDir }) {
  if (!SUPPORTED_API_KEY_PROVIDERS.includes(provider)) {
    throw new Error(`Unsupported API-key provider: ${provider}`);
  }
  const profileDir = getProfileDir(provider, accountId);
  const configDir = getToolConfigDir(provider, accountId);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const env = {};
  if (provider === 'codex') {
    env.OPENAI_API_KEY = config.apiKey;
    if (config.baseUrl) env.OPENAI_BASE_URL = config.baseUrl;
    writeJsonFile(fs, path, path.join(configDir, 'auth.json'), { OPENAI_API_KEY: config.apiKey });
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
  writeJsonFile(fs, path, path.join(profileDir, '.aih_env.json'), env);
}

function writeOAuthAccount({ fs, path, provider, accountId, auth, getProfileDir, getToolConfigDir }) {
  const profileDir = getProfileDir(provider, accountId);
  const configDir = getToolConfigDir(provider, accountId);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  if (provider === 'codex') {
    writeJsonFile(fs, path, path.join(configDir, 'auth.json'), auth);
    return;
  }
  if (provider === 'gemini') {
    writeJsonFile(fs, path, path.join(profileDir, '.gemini', 'oauth_creds.json'), auth);
    return;
  }
  if (provider === 'claude') {
    writeJsonFile(fs, path, path.join(configDir, '.credentials.json'), auth);
    return;
  }
  if (provider === 'agy') {
    const email = extractOAuthEmail(provider, auth);
    const authToWrite = { ...auth };
    delete authToWrite.email;
    writeJsonFile(fs, path, path.join(configDir, 'antigravity-oauth-token'), authToWrite);
    if (email) {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'email.cache'), email, 'utf8');
    }
  }
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

function writeSub2ApiMetadata({ fs, path, provider, accountId, account, getProfileDir }) {
  const patch = buildSub2ApiMetadataPatch(account);
  if (!patch) return;
  writeTransferMetadata({
    fs,
    path,
    profileDir: getProfileDir(provider, accountId),
    patch
  });
}

function normalizeOAuthAuth(provider, account) {
  const rawAuth = account && account.auth && typeof account.auth === 'object'
    ? { ...account, ...account.auth }
    : account;
  if (provider === 'codex') return normalizeCodexAuthPayload(rawAuth);
  if (provider === 'gemini') {
    const email = extractOAuthEmail(provider, account);
    const auth = account && account.auth && typeof account.auth === 'object' ? account.auth : account;
    return email && auth && !auth.email ? { ...auth, email } : auth;
  }
  if (provider === 'claude') {
    const email = extractOAuthEmail(provider, account);
    const auth = account && account.auth && typeof account.auth === 'object' ? account.auth : account;
    return email && auth && !auth.email ? { ...auth, email } : auth;
  }
  if (provider === 'agy') {
    const email = extractOAuthEmail(provider, account);
    const auth = account && account.auth && typeof account.auth === 'object' ? account.auth : account;
    return email && auth && !auth.email ? { ...auth, email } : auth;
  }
  return null;
}

function importStandardAccountRecords(options = {}) {
  const {
    fs,
    path,
    records,
    getToolAccountIds,
    getProfileDir,
    getToolConfigDir,
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
          summary.accounts.push({ provider, accountId: '', status: 'invalid', reason: 'unsupported_api_key_provider' });
          continue;
        }
        const existingId = findExistingAccountByIdentity({
          fs,
          path,
          provider,
          identityKind: 'api-key',
          identityPayload: apiKeyConfig,
          getToolAccountIds,
          getProfileDir,
          getToolConfigDir
        });
        if (existingId) {
          summary.duplicates += 1;
          summary.accounts.push({ provider, accountId: existingId, status: 'skipped', reason: 'duplicate_api_key' });
          continue;
        }
        const accountId = dryRun ? `dry-run-${summary.imported + 1}` : claimNextAccountId({ fs, provider, getToolAccountIds, getProfileDir });
        const before = dryRun ? null : snapshotAuthArtifacts(accountArtifactHooks, provider, accountId);
        if (!dryRun) {
          writeApiKeyAccount({ fs, path, provider, accountId, config: apiKeyConfig, getProfileDir, getToolConfigDir });
          writeSub2ApiMetadata({ fs, path, provider, accountId, account, getProfileDir });
          notifyAuthArtifactsChanged(accountArtifactHooks, provider, accountId, before, source, 'imported_credentials_updated');
        }
        summary.imported += 1;
        summary.accounts.push({ provider, accountId, status: 'created', authMode: 'api-key' });
        continue;
      }

      const auth = normalizeOAuthAuth(provider, account);
      if (!auth || !buildOAuthIdentity(provider, auth)) {
        summary.invalid += 1;
        continue;
      }
      const existingId = findExistingAccountByIdentity({
        fs,
        path,
        provider,
        identityKind: 'oauth',
        identityPayload: auth,
        getToolAccountIds,
        getProfileDir,
        getToolConfigDir
      });
      if (existingId) {
        summary.duplicates += 1;
        summary.accounts.push({ provider, accountId: existingId, status: 'skipped', reason: 'duplicate_oauth_identity' });
        continue;
      }
      const accountId = dryRun ? `dry-run-${summary.imported + 1}` : claimNextAccountId({ fs, provider, getToolAccountIds, getProfileDir });
      const before = dryRun ? null : snapshotAuthArtifacts(accountArtifactHooks, provider, accountId);
      if (!dryRun) {
        writeOAuthAccount({ fs, path, provider, accountId, auth, getProfileDir, getToolConfigDir });
        writeSub2ApiMetadata({ fs, path, provider, accountId, account, getProfileDir });
        notifyAuthArtifactsChanged(accountArtifactHooks, provider, accountId, before, source, 'imported_credentials_updated');
      }
      summary.imported += 1;
      summary.accounts.push({ provider, accountId, status: 'created', authMode: 'oauth' });
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
