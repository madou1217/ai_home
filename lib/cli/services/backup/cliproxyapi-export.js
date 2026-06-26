'use strict';

const {
  buildApiKeyIdentity,
  buildOAuthIdentity,
  compareCredentialQuality,
  extractApiKeyConfig,
  buildCliproxyapiCodexAuth,
  buildAiHomeCodexAuthFromCliproxyapi,
  isCodexAuthPayload,
  normalizeBaseUrl,
  buildCanonicalFileName
} = require('../../../account/transfer-core');

const CLIPROXYAPI_API_KEY_PROVIDERS = Object.freeze(['codex', 'gemini', 'claude']);
const CLIPROXYAPI_DATA_TYPE = 'cliproxyapi-data';
const CLIPROXYAPI_DATA_VERSION = 1;
const TRANSFER_METADATA_FILE = '.aih_transfer.json';
const OPENAI_COMPATIBILITY_YAML_KEY = 'openai-compatibility';
const CLIPROXYAPI_API_KEY_PASSTHROUGH_KEYS = Object.freeze([
  'prefix',
  'disable-cooling',
  'headers',
  'proxy-url',
  'models',
  'excluded-models'
]);
const CLIPROXYAPI_API_KEY_CONFIG = Object.freeze({
  codex: Object.freeze({
    yamlKey: 'codex-api-key',
    defaultBaseUrl: 'https://api.openai.com/v1',
    configDirName: '.codex',
    envKey: 'OPENAI_API_KEY',
    baseUrlEnvKey: 'OPENAI_BASE_URL',
    authFileName: 'auth.json',
    authApiKey: 'OPENAI_API_KEY'
  }),
  gemini: Object.freeze({
    yamlKey: 'gemini-api-key',
    defaultBaseUrl: '',
    configDirName: '.gemini',
    envKey: 'GEMINI_API_KEY',
    baseUrlEnvKey: 'GEMINI_BASE_URL'
  }),
  claude: Object.freeze({
    yamlKey: 'claude-api-key',
    defaultBaseUrl: '',
    configDirName: '.claude',
    envKey: 'ANTHROPIC_API_KEY',
    baseUrlEnvKey: 'ANTHROPIC_BASE_URL'
  })
});

function createCliproxyapiExportService(options = {}) {
  const {
    fs,
    path,
    aiHomeDir,
    hostHomeDir,
    accountArtifactHooks
  } = options;

  function readJsonFileSafe(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  function writeJsonFile(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  function readTransferMetadata(profileDir) {
    const metadata = readJsonFileSafe(path.join(profileDir, TRANSFER_METADATA_FILE));
    return metadata && typeof metadata === 'object' ? metadata : {};
  }

  function writeTransferMetadata(profileDir, patch) {
    const existing = readTransferMetadata(profileDir);
    const next = {
      ...existing,
      version: 1,
      formats: mergeTransferFormats(existing.formats, patch.formats)
    };
    if (Object.keys(next.formats).length === 0) return;
    writeJsonFile(path.join(profileDir, TRANSFER_METADATA_FILE), next);
  }

  function mergeTransferFormats(existingFormats, patchFormats) {
    const existing = isPlainObject(existingFormats) ? existingFormats : {};
    const patch = isPlainObject(patchFormats) ? patchFormats : {};
    return mergePlainObjects(existing, patch);
  }

  function mergePlainObjects(left, right) {
    const out = { ...left };
    Object.entries(right).forEach(([key, value]) => {
      out[key] = isPlainObject(value) && isPlainObject(out[key])
        ? mergePlainObjects(out[key], value)
        : value;
    });
    return out;
  }

  function readCliproxyapiApiKeyMetadata(profileDir, provider) {
    const transferMetadata = readTransferMetadata(profileDir);
    return transferMetadata
      && transferMetadata.formats
      && transferMetadata.formats.cliproxyapi
      && transferMetadata.formats.cliproxyapi[provider]
      && transferMetadata.formats.cliproxyapi[provider].apiKey
      && typeof transferMetadata.formats.cliproxyapi[provider].apiKey === 'object'
      ? transferMetadata.formats.cliproxyapi[provider].apiKey
      : {};
  }

  function readOpenAICompatibilityApiKeyMetadata(profileDir) {
    const transferMetadata = readTransferMetadata(profileDir);
    return transferMetadata
      && transferMetadata.formats
      && transferMetadata.formats.cliproxyapi
      && transferMetadata.formats.cliproxyapi.openAICompatibility
      && transferMetadata.formats.cliproxyapi.openAICompatibility.apiKey
      && typeof transferMetadata.formats.cliproxyapi.openAICompatibility.apiKey === 'object'
      ? transferMetadata.formats.cliproxyapi.openAICompatibility.apiKey
      : {};
  }

  function stripInlineYamlComment(text) {
    let quote = '';
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) {
        if (ch === quote && text[i - 1] !== '\\') quote = '';
        continue;
      }
      if (ch === '\'' || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === '#') return text.slice(0, i).trim();
    }
    return text.trim();
  }

  function normalizeYamlScalar(text) {
    const raw = stripInlineYamlComment(String(text || '').trim());
    if (!raw) return '';
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('\'') && raw.endsWith('\''))) {
      return raw.slice(1, -1);
    }
    return raw;
  }

  function expandUserPath(targetPath, baseDir) {
    const text = String(targetPath || '').trim();
    if (!text) return '';
    if (text === '~') return hostHomeDir;
    if (text.startsWith('~/') || text.startsWith('~\\')) {
      return path.join(hostHomeDir, text.slice(2));
    }
    if (path.isAbsolute(text)) return text;
    return path.resolve(baseDir, text);
  }

  function resolveCliproxyapiConfigPath() {
    const candidates = [
      path.join(hostHomeDir, '.cli-proxy-api', 'config.yaml'),
      path.join(hostHomeDir, '.cli-proxy-api', 'config.yml')
    ];
    return candidates.find((candidate) => {
      try {
        return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
      } catch (_error) {
        return false;
      }
    }) || '';
  }

  function resolveCliproxyapiAuthDir() {
    const configPath = resolveCliproxyapiConfigPath();
    if (!configPath) {
      return {
        configPath: '',
        authDir: path.join(hostHomeDir, '.cli-proxy-api')
      };
    }

    const yamlText = fs.readFileSync(configPath, 'utf8');
    const lines = yamlText.split(/\r?\n/);
    const baseDir = path.dirname(configPath);
    for (const line of lines) {
      if (!/^\s*auth-dir\s*:/.test(line)) continue;
      const rawValue = line.replace(/^\s*auth-dir\s*:\s*/, '');
      const normalized = normalizeYamlScalar(rawValue);
      return {
        configPath,
        authDir: expandUserPath(normalized, baseDir) || path.join(hostHomeDir, '.cli-proxy-api')
      };
    }

    return {
      configPath,
      authDir: path.join(hostHomeDir, '.cli-proxy-api')
    };
  }

  function buildIdentityKey(payload) {
    return buildOAuthIdentity('codex', payload);
  }

  function normalizeApiKeyProviders(providers) {
    const requested = Array.isArray(providers) && providers.length > 0
      ? providers
      : CLIPROXYAPI_API_KEY_PROVIDERS;
    return Array.from(new Set(requested
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((item) => CLIPROXYAPI_API_KEY_CONFIG[item])));
  }

  function buildCliproxyapiApiKeyIdentity(provider, config) {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const providerConfig = CLIPROXYAPI_API_KEY_CONFIG[normalizedProvider];
    if (!providerConfig) return '';
    const extracted = extractApiKeyConfig(normalizedProvider, config);
    if (!extracted.apiKey) return '';
    return buildApiKeyIdentity(normalizedProvider, {
      apiKey: extracted.apiKey,
      baseUrl: extracted.baseUrl || providerConfig.defaultBaseUrl
    });
  }

  function isManagedCodexExportFile(fileName) {
    return /^codex-aih-\d+\.json$/i.test(String(fileName || '').trim());
  }

  function listExistingAuthFiles(authDir) {
    try {
      return fs.readdirSync(authDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.json$/i.test(String(entry.name || '')))
        .map((entry) => {
          const fileName = String(entry.name);
          const filePath = path.join(authDir, fileName);
          const payload = readJsonFileSafe(filePath);
          return {
            fileName,
            filePath,
            payload,
            identityKey: buildIdentityKey(payload),
            isCodex: isCodexAuthPayload(payload),
            isManaged: isManagedCodexExportFile(fileName)
          };
        });
    } catch (_error) {
      return [];
    }
  }

  function listProviderAccountIds(provider) {
    const providerDir = path.join(aiHomeDir, 'profiles', provider);
    try {
      return fs.readdirSync(providerDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(String(entry.name || '')))
        .map((entry) => String(entry.name))
        .sort((a, b) => Number(a) - Number(b));
    } catch (_error) {
      return [];
    }
  }

  function listCodexAccountIds() {
    return listProviderAccountIds('codex');
  }

  function collectExistingAiHomeCodexAccounts() {
    const accounts = new Map();
    const providerDir = path.join(aiHomeDir, 'profiles', 'codex');
    const ids = listCodexAccountIds();
    ids.forEach((id) => {
      const authPath = path.join(providerDir, id, '.codex', 'auth.json');
      const authJson = readJsonFileSafe(authPath);
      const payload = buildCliproxyapiCodexAuth(authJson);
      if (!payload) return;
      const identityKey = buildIdentityKey(payload);
      if (!identityKey) return;
      const existing = accounts.get(identityKey);
      if (!existing || compareCredentialQuality(payload, existing.payload) > 0) {
        accounts.set(identityKey, {
          id,
          authPath,
          payload
        });
      }
    });
    return accounts;
  }

  function collectExistingAiHomeApiKeyAccounts(provider) {
    const providerConfig = CLIPROXYAPI_API_KEY_CONFIG[provider];
    if (!providerConfig) return new Map();
    const accounts = new Map();
    const providerDir = path.join(aiHomeDir, 'profiles', provider);
    const ids = listProviderAccountIds(provider);
    ids.forEach((id) => {
      const profileDir = path.join(providerDir, id);
      const config = readJsonFileSafe(path.join(profileDir, '.aih_env.json')) || {};
      const auth = providerConfig.authFileName
        ? (readJsonFileSafe(path.join(profileDir, providerConfig.configDirName, providerConfig.authFileName)) || {})
        : {};
      const extracted = extractApiKeyConfig(provider, { config, auth });
      if (!extracted.apiKey) return;
      if (provider === 'codex' && Object.keys(readOpenAICompatibilityApiKeyMetadata(profileDir)).length > 0) return;
      const cliproxyapiMetadata = readCliproxyapiApiKeyMetadata(profileDir, provider);
      const payload = {
        ...extractApiKeyPassthrough(cliproxyapiMetadata),
        'api-key': extracted.apiKey,
        ...(extracted.baseUrl || providerConfig.defaultBaseUrl
          ? { 'base-url': extracted.baseUrl || providerConfig.defaultBaseUrl }
          : {})
      };
      const identityKey = buildCliproxyapiApiKeyIdentity(provider, payload);
      if (!identityKey || accounts.has(identityKey)) return;
      accounts.set(identityKey, {
        provider,
        id,
        profileDir,
        payload,
        identityKey
      });
    });
    return accounts;
  }

  function collectExistingOpenAICompatibilityApiKeyAccounts() {
    const provider = 'codex';
    const providerConfig = CLIPROXYAPI_API_KEY_CONFIG[provider];
    const accounts = new Map();
    const providerDir = path.join(aiHomeDir, 'profiles', provider);
    const ids = listProviderAccountIds(provider);
    ids.forEach((id) => {
      const profileDir = path.join(providerDir, id);
      const metadata = readOpenAICompatibilityApiKeyMetadata(profileDir);
      if (Object.keys(metadata).length === 0) return;
      const config = readJsonFileSafe(path.join(profileDir, '.aih_env.json')) || {};
      const auth = readJsonFileSafe(path.join(profileDir, providerConfig.configDirName, providerConfig.authFileName)) || {};
      const extracted = extractApiKeyConfig(provider, { config, auth });
      if (!extracted.apiKey) return;
      const payload = {
        ...extractOpenAICompatibilityPassthrough(metadata),
        'api-key': extracted.apiKey,
        'base-url': normalizeBaseUrl(metadata['base-url']) || extracted.baseUrl || providerConfig.defaultBaseUrl
      };
      const identityKey = buildCliproxyapiApiKeyIdentity(provider, payload);
      if (!identityKey || accounts.has(identityKey)) return;
      accounts.set(identityKey, {
        provider,
        id,
        profileDir,
        payload,
        identityKey
      });
    });
    return accounts;
  }

  function countLeadingSpaces(line) {
    const match = String(line || '').match(/^ */);
    return match ? match[0].length : 0;
  }

  function findApiKeyBlock(yamlText, yamlKey) {
    const lines = String(yamlText || '').split(/\r?\n/);
    const escapedKey = String(yamlKey || '').replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    const start = lines.findIndex((line) => new RegExp(`^\\s*${escapedKey}\\s*:`).test(line));
    if (start < 0) return { lines, start: -1, end: -1, baseIndent: 0 };
    const baseIndent = countLeadingSpaces(lines[start]);
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (!String(line || '').trim() || /^\s*#/.test(line)) continue;
      if (countLeadingSpaces(line) <= baseIndent && /^\s*[^-\s][^:]*\s*:/.test(line)) {
        end = index;
        break;
      }
    }
    return { lines, start, end, baseIndent };
  }

  function parseSimpleYamlMapEntry(text) {
    const trimmed = String(text || '').trim();
    const match = trimmed.match(/^([^:]+)\s*:\s*(.*)$/);
    if (!match) return null;
    return {
      key: String(match[1] || '').trim(),
      value: normalizeYamlScalar(match[2] || '')
    };
  }

  function normalizeYamlBoolean(value) {
    if (typeof value === 'boolean') return value;
    const text = String(value || '').trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
    return null;
  }

  function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function copyStringMap(value) {
    if (!isPlainObject(value)) return null;
    const out = {};
    Object.entries(value).forEach(([key, item]) => {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey) return;
      out[normalizedKey] = String(item == null ? '' : item).trim();
    });
    return Object.keys(out).length > 0 ? out : null;
  }

  function copyModelList(value) {
    if (!Array.isArray(value)) return null;
    const models = value
      .map((item) => {
        if (!isPlainObject(item)) return null;
        const out = {};
        Object.entries(item).forEach(([key, entryValue]) => {
          const normalizedKey = String(key || '').trim();
          const normalizedValue = String(entryValue == null ? '' : entryValue).trim();
          if (!normalizedKey || !normalizedValue) return;
          out[normalizedKey] = normalizedValue;
        });
        return Object.keys(out).length > 0 ? out : null;
      })
      .filter(Boolean);
    return models.length > 0 ? models : null;
  }

  function copyStringList(value) {
    if (!Array.isArray(value)) return null;
    const out = value
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    return out.length > 0 ? out : null;
  }

  function extractApiKeyPassthrough(entry) {
    const payload = entry && typeof entry === 'object' ? entry : {};
    const out = {};
    const prefix = String(payload.prefix || '').trim();
    if (prefix) out.prefix = prefix;
    const disableCooling = normalizeYamlBoolean(payload['disable-cooling']);
    if (disableCooling !== null) out['disable-cooling'] = disableCooling;
    const headers = copyStringMap(payload.headers);
    if (headers) out.headers = headers;
    const proxyUrl = String(payload['proxy-url'] || payload.proxyUrl || '').trim();
    if (proxyUrl) out['proxy-url'] = proxyUrl;
    const models = copyModelList(payload.models);
    if (models) out.models = models;
    const excludedModels = copyStringList(payload['excluded-models'] || payload.excludedModels);
    if (excludedModels) out['excluded-models'] = excludedModels;
    return out;
  }

  function buildCliproxyapiMetadataPatch(provider, entry) {
    const passthrough = extractApiKeyPassthrough(entry);
    if (Object.keys(passthrough).length === 0) return {};
    return {
      formats: {
        cliproxyapi: {
          [provider]: {
            apiKey: passthrough
          }
        }
      }
    };
  }

  function buildOpenAICompatibilityMetadataPatch(entry) {
    const passthrough = extractOpenAICompatibilityPassthrough(entry);
    if (Object.keys(passthrough).length === 0) return {};
    return {
      formats: {
        cliproxyapi: {
          openAICompatibility: {
            apiKey: passthrough
          }
        }
      }
    };
  }

  function parseApiKeyEntries(yamlText, provider) {
    const providerConfig = CLIPROXYAPI_API_KEY_CONFIG[provider];
    if (!providerConfig) return [];
    const block = findApiKeyBlock(yamlText, providerConfig.yamlKey);
    if (block.start < 0) return [];
    const entries = [];
    let current = null;
    let section = '';
    let currentModel = null;
    for (let index = block.start + 1; index < block.end; index += 1) {
      const rawLine = block.lines[index];
      const trimmed = String(rawLine || '').trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = countLeadingSpaces(rawLine);
      if (trimmed.startsWith('- ')) {
        const afterDash = trimmed.slice(2).trim();
        if (section === 'models' && current && indent > block.baseIndent + 2) {
          const model = {};
          const pair = parseSimpleYamlMapEntry(afterDash);
          if (pair) model[pair.key] = pair.value;
          current.models.push(model);
          currentModel = model;
          continue;
        }
        if (section === 'excluded-models' && current && indent > block.baseIndent + 2) {
          current['excluded-models'].push(normalizeYamlScalar(afterDash));
          continue;
        }
        current = {};
        entries.push(current);
        section = '';
        currentModel = null;
        const pair = parseSimpleYamlMapEntry(afterDash);
        if (pair) current[pair.key] = pair.value;
        continue;
      }
      if (!current) continue;
      const pair = parseSimpleYamlMapEntry(trimmed);
      if (!pair) continue;
      if (section === 'headers' && indent > block.baseIndent + 4) {
        current.headers[pair.key] = pair.value;
        continue;
      }
      if (section === 'models' && currentModel && indent > block.baseIndent + 4) {
        currentModel[pair.key] = pair.value;
        continue;
      }
      if (section && indent <= block.baseIndent + 4) {
        section = '';
        currentModel = null;
      }
      if (pair.key === 'headers') {
        current.headers = {};
        section = 'headers';
        currentModel = null;
        continue;
      }
      if (pair.key === 'models') {
        current.models = [];
        section = 'models';
        currentModel = null;
        continue;
      }
      if (pair.key === 'excluded-models') {
        current['excluded-models'] = [];
        section = 'excluded-models';
        currentModel = null;
        continue;
      }
      current[pair.key] = pair.value;
      section = '';
      currentModel = null;
    }
    return entries.filter((entry) => extractApiKeyConfig(provider, entry).apiKey);
  }

  function parseOpenAICompatibilityEntries(yamlText) {
    const block = findApiKeyBlock(yamlText, OPENAI_COMPATIBILITY_YAML_KEY);
    if (block.start < 0) return [];
    const entries = [];
    let current = null;
    let currentApiKeyEntry = null;
    let currentModel = null;
    let section = '';
    for (let index = block.start + 1; index < block.end; index += 1) {
      const rawLine = block.lines[index];
      const trimmed = String(rawLine || '').trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = countLeadingSpaces(rawLine);
      if (trimmed.startsWith('- ')) {
        const afterDash = trimmed.slice(2).trim();
        const pair = parseSimpleYamlMapEntry(afterDash);
        if (section === 'api-key-entries' && current && indent > block.baseIndent + 2) {
          const entry = {};
          if (pair) entry[pair.key] = pair.value;
          current['api-key-entries'].push(entry);
          currentApiKeyEntry = entry;
          currentModel = null;
          continue;
        }
        if (section === 'models' && current && indent > block.baseIndent + 2) {
          const model = {};
          if (pair) model[pair.key] = pair.value;
          current.models.push(model);
          currentModel = model;
          currentApiKeyEntry = null;
          continue;
        }
        current = {};
        entries.push(current);
        section = '';
        currentApiKeyEntry = null;
        currentModel = null;
        if (pair) current[pair.key] = pair.value;
        continue;
      }
      if (!current) continue;
      const pair = parseSimpleYamlMapEntry(trimmed);
      if (!pair) continue;
      if (section === 'headers' && indent > block.baseIndent + 4) {
        current.headers[pair.key] = pair.value;
        continue;
      }
      if (section === 'api-key-entries' && currentApiKeyEntry && indent > block.baseIndent + 4) {
        currentApiKeyEntry[pair.key] = pair.value;
        continue;
      }
      if (section === 'models' && currentModel && indent > block.baseIndent + 4) {
        currentModel[pair.key] = pair.value;
        continue;
      }
      if (section && indent <= block.baseIndent + 4) {
        section = '';
        currentApiKeyEntry = null;
        currentModel = null;
      }
      if (pair.key === 'headers') {
        current.headers = {};
        section = 'headers';
        currentApiKeyEntry = null;
        currentModel = null;
        continue;
      }
      if (pair.key === 'api-key-entries') {
        current['api-key-entries'] = [];
        section = 'api-key-entries';
        currentApiKeyEntry = null;
        currentModel = null;
        continue;
      }
      if (pair.key === 'models') {
        current.models = [];
        section = 'models';
        currentApiKeyEntry = null;
        currentModel = null;
        continue;
      }
      current[pair.key] = pair.value;
      section = '';
      currentApiKeyEntry = null;
      currentModel = null;
    }
    return entries
      .flatMap((entry) => {
        const apiKeyEntries = Array.isArray(entry['api-key-entries']) ? entry['api-key-entries'] : [];
        return apiKeyEntries.map((apiKeyEntry) => ({
          ...entry,
          'api-key': apiKeyEntry['api-key'] || apiKeyEntry.apiKey || apiKeyEntry.api_key,
          'api-key-entry': apiKeyEntry,
          'proxy-url': apiKeyEntry['proxy-url'] || apiKeyEntry.proxyUrl || entry['proxy-url'] || entry.proxyUrl || ''
        }));
      })
      .filter((entry) => extractApiKeyConfig('codex', entry).apiKey && normalizeBaseUrl(entry['base-url'] || entry.baseUrl || entry.base_url));
  }

  function extractOpenAICompatibilityPassthrough(entry) {
    const payload = entry && typeof entry === 'object' ? entry : {};
    const out = {};
    ['name', 'prefix'].forEach((key) => {
      const value = String(payload[key] || '').trim();
      if (value) out[key] = value;
    });
    const disabled = normalizeYamlBoolean(payload.disabled);
    if (disabled !== null) out.disabled = disabled;
    const disableCooling = normalizeYamlBoolean(payload['disable-cooling']);
    if (disableCooling !== null) out['disable-cooling'] = disableCooling;
    const baseUrl = normalizeBaseUrl(payload['base-url'] || payload.baseUrl || payload.base_url);
    if (baseUrl) out['base-url'] = baseUrl;
    const headers = copyStringMap(payload.headers);
    if (headers) out.headers = headers;
    const models = copyModelList(payload.models);
    if (models) out.models = models;
    const apiKeyEntry = payload['api-key-entry'] && typeof payload['api-key-entry'] === 'object'
      ? payload['api-key-entry']
      : {};
    const proxyUrl = String(payload['proxy-url'] || payload.proxyUrl || apiKeyEntry['proxy-url'] || apiKeyEntry.proxyUrl || '').trim();
    if (proxyUrl) out['proxy-url'] = proxyUrl;
    return out;
  }

  function getNextAccountId(provider) {
    const ids = listProviderAccountIds(provider)
      .map((item) => Number(item))
      .filter((value) => Number.isInteger(value) && value > 0);
    if (ids.length === 0) return 1;
    return Math.max(...ids) + 1;
  }

  function claimNextAccountId(provider) {
    let candidate = getNextAccountId(provider);
    fs.mkdirSync(path.join(aiHomeDir, 'profiles', provider), { recursive: true });
    while (true) {
      const id = String(candidate);
      const profileDir = path.join(aiHomeDir, 'profiles', provider, id);
      try {
        fs.mkdirSync(profileDir);
        return id;
      } catch (error) {
        if (error && error.code === 'EEXIST') {
          candidate += 1;
          continue;
        }
        throw error;
      }
    }
  }

  function notifyAuthArtifactsChanged(provider, accountId, before, source, reason) {
    if (!before || !accountArtifactHooks || typeof accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged !== 'function') return;
    accountArtifactHooks.notifyDefaultAccountAuthUpdatedIfChanged({
      provider,
      accountId,
      before,
      source,
      reason
    });
  }

  function buildEnvFromApiKey(provider, entry) {
    const providerConfig = CLIPROXYAPI_API_KEY_CONFIG[provider];
    const config = extractApiKeyConfig(provider, entry);
    const env = {
      [providerConfig.envKey]: config.apiKey
    };
    if (providerConfig.baseUrlEnvKey && config.baseUrl) {
      env[providerConfig.baseUrlEnvKey] = config.baseUrl;
    }
    return env;
  }

  function buildAuthFromApiKey(provider, entry) {
    const providerConfig = CLIPROXYAPI_API_KEY_CONFIG[provider];
    if (!providerConfig.authApiKey) return null;
    const config = extractApiKeyConfig(provider, entry);
    return {
      [providerConfig.authApiKey]: config.apiKey
    };
  }

  function writeJsonExport(outPath, payload) {
    const resolved = path.resolve(String(outPath || ''));
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return resolved;
  }

  function buildOAuthDataRecord(entry) {
    const payload = entry && entry.payload ? entry.payload : {};
    return {
      provider: 'codex',
      type: 'oauth',
      email: String(payload.email || '').trim().toLowerCase(),
      auth: payload
    };
  }

  function buildApiKeyDataRecord(entry, source) {
    const provider = entry.provider;
    const config = extractApiKeyConfig(provider, entry.payload);
    return {
      provider,
      type: 'api-key',
      config: {
        apiKey: config.apiKey,
        baseUrl: config.baseUrl
      },
      cliproxyapi: {
        source,
        yamlKey: source === 'openai-compatibility'
          ? OPENAI_COMPATIBILITY_YAML_KEY
          : CLIPROXYAPI_API_KEY_CONFIG[provider].yamlKey,
        entry: entry.payload
      }
    };
  }

  function buildCliproxyapiDataPayload(optionsArg = {}) {
    const apiKeyProviders = normalizeApiKeyProviders(optionsArg.apiKeyProviders);
    const accounts = [];
    const includeCodexOAuth = apiKeyProviders.includes('codex');
    if (includeCodexOAuth) {
      collectExistingAiHomeCodexAccounts().forEach((entry) => {
        accounts.push(buildOAuthDataRecord(entry));
      });
    }

    const openAICompatibility = includeCodexOAuth
      ? Array.from(collectExistingOpenAICompatibilityApiKeyAccounts().values())
      : [];
    openAICompatibility.forEach((entry) => {
      accounts.push(buildApiKeyDataRecord(entry, 'openai-compatibility'));
    });

    apiKeyProviders.forEach((provider) => {
      collectExistingAiHomeApiKeyAccounts(provider).forEach((entry) => {
        accounts.push(buildApiKeyDataRecord(entry, CLIPROXYAPI_API_KEY_CONFIG[provider].yamlKey));
      });
    });

    return {
      type: CLIPROXYAPI_DATA_TYPE,
      version: CLIPROXYAPI_DATA_VERSION,
      exported_at: new Date().toISOString(),
      accounts
    };
  }

  function exportCliproxyapiData(optionsArg = {}) {
    const payload = buildCliproxyapiDataPayload(optionsArg);
    const outPath = writeJsonExport(optionsArg.outPath, payload);
    return {
      format: 'cliproxyapi',
      outPath,
      accounts: payload.accounts.length,
      oauthAccounts: payload.accounts.filter((account) => account.type === 'oauth').length,
      apiKeys: payload.accounts.filter((account) => account.type === 'api-key').length
    };
  }

  function importCliproxyapiCodexAuths(options = {}) {
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const dryRun = !!options.dryRun;
    const apiKeyProviders = normalizeApiKeyProviders(options.apiKeyProviders);
    const includeCodexOAuth = apiKeyProviders.includes('codex');
    const resolved = resolveCliproxyapiAuthDir();
    const existingFiles = includeCodexOAuth
      ? listExistingAuthFiles(resolved.authDir).filter((entry) => entry.isCodex)
      : [];
    const normalizedExistingFiles = existingFiles || [];
    const configText = resolved.configPath && fs.existsSync(resolved.configPath)
      ? fs.readFileSync(resolved.configPath, 'utf8')
      : '';
    const apiKeyEntries = apiKeyProviders.flatMap((provider) => parseApiKeyEntries(configText, provider)
      .map((entry, index) => ({
        provider,
        entry,
        index,
        identityKey: buildCliproxyapiApiKeyIdentity(provider, entry)
      }))
      .filter((item) => item.identityKey));
    const openAICompatibilityEntries = apiKeyProviders.includes('codex')
      ? parseOpenAICompatibilityEntries(configText)
        .map((entry, index) => ({
          provider: 'codex',
          entry,
          index,
          identityKey: buildCliproxyapiApiKeyIdentity('codex', entry),
          compatibility: true
        }))
        .filter((item) => item.identityKey)
      : [];
    const existingAiHomeAccounts = collectExistingAiHomeCodexAccounts();
    apiKeyProviders.forEach((provider) => {
      collectExistingAiHomeApiKeyAccounts(provider).forEach((entry, identityKey) => {
        existingAiHomeAccounts.set(identityKey, entry);
      });
    });
    let imported = 0;
    let duplicates = 0;
    let invalid = 0;
    let failed = 0;
    const importedIds = [];
    const queuedByIdentity = new Map();
    const providersSeen = new Set();
    const totalEntries = normalizedExistingFiles.length + apiKeyEntries.length + openAICompatibilityEntries.length;

    function emitProgress(extra = {}) {
      if (!onProgress) return;
      onProgress({
        provider: 'codex',
        total: totalEntries,
        scanned: Number(extra.scanned != null ? extra.scanned : 0),
        imported,
        duplicates,
        invalid,
        failed,
        dryRun,
        ...extra
      });
    }

    emitProgress({ scanned: 0, status: 'start' });

    normalizedExistingFiles.forEach((entry, index) => {
      providersSeen.add('codex');
      const scanned = index + 1;
      const authJson = buildAiHomeCodexAuthFromCliproxyapi(entry.payload);
      if (!authJson) {
        invalid += 1;
        emitProgress({ scanned, fileName: entry.fileName, status: 'invalid' });
        return;
      }
      const identityPayload = buildCliproxyapiCodexAuth(authJson);
      const identityKey = buildIdentityKey(identityPayload);
      if (!identityKey) {
        invalid += 1;
        emitProgress({ scanned, fileName: entry.fileName, status: 'invalid' });
        return;
      }
      const queued = queuedByIdentity.get(identityKey);
      if (queued) {
        if (compareCredentialQuality(identityPayload, queued.identityPayload) > 0) {
          queuedByIdentity.set(identityKey, {
            credentialKind: 'oauth',
            provider: 'codex',
            entry,
            authJson,
            identityPayload,
            identityKey
          });
          duplicates += 1;
          emitProgress({ scanned, fileName: entry.fileName, email: identityPayload.email, status: 'deduped_source_upgrade' });
        } else {
          duplicates += 1;
          emitProgress({ scanned, fileName: entry.fileName, email: identityPayload.email, status: 'deduped_source' });
        }
        return;
      }
      const existing = existingAiHomeAccounts.get(identityKey);
      if (existing) {
        duplicates += 1;
        emitProgress({ scanned, fileName: entry.fileName, email: identityPayload.email, status: 'duplicate' });
        return;
      }
      queuedByIdentity.set(identityKey, {
        credentialKind: 'oauth',
        provider: 'codex',
        entry,
        authJson,
        identityPayload,
        identityKey
      });
    });

    apiKeyEntries.forEach((item, index) => {
      const scanned = normalizedExistingFiles.length + index + 1;
      const { provider, entry, identityKey } = item;
      providersSeen.add(provider);
      const queued = queuedByIdentity.get(identityKey);
      if (queued) {
        duplicates += 1;
        emitProgress({ scanned, fileName: `config.yaml#${CLIPROXYAPI_API_KEY_CONFIG[provider].yamlKey}[${index}]`, provider, status: 'deduped_source' });
        return;
      }
      const existing = existingAiHomeAccounts.get(identityKey);
      if (existing) {
        duplicates += 1;
        emitProgress({ scanned, fileName: `config.yaml#${CLIPROXYAPI_API_KEY_CONFIG[provider].yamlKey}[${index}]`, provider, status: 'duplicate_api_key' });
        return;
      }
      queuedByIdentity.set(identityKey, {
        credentialKind: 'api-key',
        provider,
        entry,
        identityKey
      });
    });

    openAICompatibilityEntries.forEach((item, index) => {
      const scanned = normalizedExistingFiles.length + apiKeyEntries.length + index + 1;
      const { provider, entry, identityKey } = item;
      providersSeen.add('openai-compatibility');
      const queued = queuedByIdentity.get(identityKey);
      if (queued) {
        duplicates += 1;
        emitProgress({ scanned, fileName: `config.yaml#${OPENAI_COMPATIBILITY_YAML_KEY}[${index}]`, provider: 'openai-compatibility', status: 'deduped_source' });
        return;
      }
      const existing = existingAiHomeAccounts.get(identityKey);
      if (existing) {
        duplicates += 1;
        emitProgress({ scanned, fileName: `config.yaml#${OPENAI_COMPATIBILITY_YAML_KEY}[${index}]`, provider: 'openai-compatibility', status: 'duplicate_api_key' });
        return;
      }
      queuedByIdentity.set(identityKey, {
        credentialKind: 'api-key',
        provider,
        entry,
        identityKey,
        compatibility: true
      });
    });

    Array.from(queuedByIdentity.values()).forEach((queuedEntry) => {
      if (!dryRun) {
        try {
          const provider = queuedEntry.provider || 'codex';
          const providerConfig = queuedEntry.credentialKind === 'api-key'
            ? (CLIPROXYAPI_API_KEY_CONFIG[provider] || CLIPROXYAPI_API_KEY_CONFIG.codex)
            : CLIPROXYAPI_API_KEY_CONFIG.codex;
          const newId = queuedEntry.credentialKind === 'api-key'
            ? claimNextAccountId(provider)
            : claimNextAccountId('codex');
          const profileDir = path.join(aiHomeDir, 'profiles', provider, newId);
          const targetDir = path.join(profileDir, providerConfig.configDirName || '.codex');
          fs.mkdirSync(targetDir, { recursive: true });
          const authSnapshotBefore = accountArtifactHooks
            && typeof accountArtifactHooks.snapshotAccountAuthArtifacts === 'function'
            ? accountArtifactHooks.snapshotAccountAuthArtifacts(provider, newId)
            : null;
          if (queuedEntry.credentialKind === 'api-key') {
            writeJsonFile(path.join(profileDir, '.aih_env.json'), buildEnvFromApiKey(provider, queuedEntry.entry));
            writeTransferMetadata(
              profileDir,
              queuedEntry.compatibility
                ? buildOpenAICompatibilityMetadataPatch(queuedEntry.entry)
                : buildCliproxyapiMetadataPatch(provider, queuedEntry.entry)
            );
            const authPayload = buildAuthFromApiKey(provider, queuedEntry.entry);
            if (authPayload && providerConfig.authFileName) {
              writeJsonFile(path.join(targetDir, providerConfig.authFileName), authPayload);
            }
          } else {
            writeJsonFile(path.join(targetDir, 'auth.json'), queuedEntry.authJson);
          }
          notifyAuthArtifactsChanged(provider, newId, authSnapshotBefore, 'cliproxyapi_import', 'imported_credentials_updated');
          existingAiHomeAccounts.set(queuedEntry.identityKey, {
            id: newId,
            provider,
            authPath: path.join(targetDir, providerConfig.authFileName || ''),
            payload: queuedEntry.identityPayload || queuedEntry.entry
          });
          importedIds.push(newId);
          imported += 1;
          emitProgress({
            scanned: totalEntries,
            id: newId,
            provider,
            fileName: queuedEntry.entry.fileName || '',
            email: queuedEntry.identityPayload && queuedEntry.identityPayload.email || '',
            status: queuedEntry.credentialKind === 'api-key' ? 'imported_api_key' : 'imported'
          });
        } catch (_error) {
          failed += 1;
          emitProgress({ scanned: totalEntries, status: 'failed' });
        }
        return;
      }
      const newId = `dry-run-${imported + 1}`;
      const provider = queuedEntry.provider || 'codex';
      existingAiHomeAccounts.set(queuedEntry.identityKey, {
        id: newId,
        provider,
        authPath: '',
        payload: queuedEntry.identityPayload || queuedEntry.entry
      });
      importedIds.push(newId);
      imported += 1;
      emitProgress({
        scanned: totalEntries,
        id: newId,
        provider,
        fileName: queuedEntry.entry.fileName || '',
        email: queuedEntry.identityPayload && queuedEntry.identityPayload.email || '',
        status: queuedEntry.credentialKind === 'api-key' ? 'imported_api_key' : 'imported'
      });
    });

    emitProgress({ scanned: totalEntries, status: 'done' });

    return {
      provider: 'codex',
      configPath: resolved.configPath,
      authDir: resolved.authDir,
      scanned: totalEntries,
      imported,
      duplicates,
      invalid,
      failed,
      dryRun,
      importedIds,
      providers: Array.from(providersSeen).sort()
    };
  }

  return {
    buildCliproxyapiDataPayload,
    exportCliproxyapiData,
    importCliproxyapiCodexAuths
  };
}

module.exports = {
  CLIPROXYAPI_DATA_TYPE,
  CLIPROXYAPI_DATA_VERSION,
  createCliproxyapiExportService
};
