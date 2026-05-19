'use strict';

const path = require('node:path');
const { isLoopbackUrl } = require('../server/http-utils');
const {
  DEFAULT_SERVER_PORT,
  buildServerBaseUrl,
  formatUrlHost,
  listSelfRelayPorts,
  normalizeServerHost: normalizeDefaultServerHost,
  normalizeServerPort: normalizeDefaultServerPort
} = require('../server/server-defaults');

const AIH_SERVER_PROFILE_ID = '.aih-server';
const AIH_SERVER_PROFILE_PROVIDERS = Object.freeze(['codex', 'claude']);
const ACCOUNT_PROVIDERS = Object.freeze(['codex', 'gemini', 'claude']);
const PROVIDER_CONFIG_DIRS = Object.freeze({
  codex: '.codex',
  gemini: '.gemini',
  claude: '.claude'
});

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeAccountId(value) {
  const id = String(value || '').trim();
  return /^\d+$/.test(id) ? id : '';
}

function supportsAihServerProfile(provider) {
  return AIH_SERVER_PROFILE_PROVIDERS.includes(normalizeProvider(provider));
}

function isAihServerProfileId(value) {
  return String(value || '').trim() === AIH_SERVER_PROFILE_ID;
}

function normalizeServerPort(value) {
  return normalizeDefaultServerPort(value, DEFAULT_SERVER_PORT);
}

function normalizeServerHost(value) {
  return normalizeDefaultServerHost(value);
}

function buildAihServerBaseUrl(serverConfig = {}) {
  return buildServerBaseUrl({
    host: formatUrlHost(serverConfig.host),
    port: normalizeServerPort(serverConfig.port)
  });
}

function buildAihServerProfileEnv(provider, serverConfig = {}) {
  const p = normalizeProvider(provider);
  if (!supportsAihServerProfile(p)) return null;
  const apiKey = String(serverConfig.apiKey || serverConfig.clientKey || '').trim() || 'dummy';
  const baseUrl = buildAihServerBaseUrl(serverConfig);
  if (p === 'codex') {
    return {
      OPENAI_API_KEY: apiKey,
      OPENAI_BASE_URL: baseUrl
    };
  }
  if (p === 'claude') {
    return {
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_BASE_URL: baseUrl
    };
  }
  return null;
}

function readJsonFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function resolveConfigDir(provider, profileDir, configDir = '') {
  const explicit = String(configDir || '').trim();
  if (explicit) return explicit;
  const suffix = PROVIDER_CONFIG_DIRS[normalizeProvider(provider)] || `.${normalizeProvider(provider)}`;
  return path.join(profileDir, suffix);
}

function readProfileEnv(fs, profileDir) {
  return readJsonFileSafe(fs, path.join(profileDir, '.aih_env.json')) || {};
}

function readCodexApiKeyInfo(fs, profileDir, configDir, accountName = '') {
  const env = readProfileEnv(fs, profileDir);
  const auth = readJsonFileSafe(fs, path.join(resolveConfigDir('codex', profileDir, configDir), 'auth.json')) || {};
  const apiKey = String(env.OPENAI_API_KEY || auth.OPENAI_API_KEY || '').trim();
  const baseUrl = String(env.OPENAI_BASE_URL || auth.OPENAI_BASE_URL || '').trim();
  return {
    apiKeyMode: Boolean(apiKey) || String(accountName || '').startsWith('API Key'),
    apiKey,
    baseUrl
  };
}

function readClaudeApiKeyInfo(fs, profileDir, configDir) {
  const env = readProfileEnv(fs, profileDir);
  const settings = readJsonFileSafe(fs, path.join(resolveConfigDir('claude', profileDir, configDir), 'settings.json')) || {};
  const settingsEnv = settings && settings.env && typeof settings.env === 'object' ? settings.env : {};
  const apiKey = String(
    env.ANTHROPIC_API_KEY
    || env.ANTHROPIC_AUTH_TOKEN
    || settingsEnv.ANTHROPIC_API_KEY
    || settingsEnv.ANTHROPIC_AUTH_TOKEN
    || ''
  ).trim();
  const baseUrl = String(env.ANTHROPIC_BASE_URL || settingsEnv.ANTHROPIC_BASE_URL || '').trim();
  return {
    apiKeyMode: Boolean(apiKey),
    apiKey,
    baseUrl
  };
}

function readApiKeyProfileInfo(input = {}) {
  const provider = normalizeProvider(input.provider);
  const fs = input.fs;
  const profileDir = String(input.profileDir || '').trim();
  if (!fs || !profileDir) {
    return { apiKeyMode: false, apiKey: '', baseUrl: '' };
  }
  if (provider === 'codex') {
    return readCodexApiKeyInfo(fs, profileDir, input.configDir, input.accountName);
  }
  if (provider === 'claude') {
    return readClaudeApiKeyInfo(fs, profileDir, input.configDir);
  }
  return { apiKeyMode: false, apiKey: '', baseUrl: '' };
}

function isSelfRelayApiKeyInfo(info, serverPort) {
  if (!info || !info.apiKeyMode || !info.baseUrl) return false;
  return listSelfRelayPorts(serverPort).some((port) => isLoopbackUrl(info.baseUrl, port));
}

function isSelfRelayApiKeyProfile(input = {}) {
  return isSelfRelayApiKeyInfo(readApiKeyProfileInfo(input), input.serverPort);
}

function listNumericProfileIds(fs, providerDir) {
  try {
    if (!providerDir || !fs.existsSync(providerDir)) return [];
    return fs.readdirSync(providerDir)
      .filter((entryName) => {
        if (!/^\d+$/.test(String(entryName || ''))) return false;
        try {
          return fs.statSync(path.join(providerDir, entryName)).isDirectory();
        } catch (_error) {
          return false;
        }
      });
  } catch (_error) {
    return [];
  }
}

function listIndexedAccountIds(accountStateIndex, provider) {
  if (!accountStateIndex || typeof accountStateIndex.listStates !== 'function') return [];
  try {
    return (accountStateIndex.listStates(provider) || [])
      .map((row) => normalizeAccountId(row && (row.accountId || row.account_id)))
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function collectCandidateAccountIds(input = {}) {
  const { fs, profilesDir, accountStateIndex, provider } = input;
  const providerDir = path.join(String(profilesDir || ''), provider);
  return Array.from(new Set([
    ...listNumericProfileIds(fs, providerDir),
    ...listIndexedAccountIds(accountStateIndex, provider)
  ])).sort((a, b) => Number(a) - Number(b));
}

function readTextFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return String(fs.readFileSync(filePath, 'utf8')).trim();
  } catch (_error) {
    return '';
  }
}

function removeFileSafe(fs, filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;
    if (typeof fs.rmSync === 'function') fs.rmSync(filePath, { force: true });
    else fs.unlinkSync(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function clearDefaultPointerIfNeeded(fs, profilesDir, provider, accountId) {
  const defaultPath = path.join(profilesDir, provider, '.aih_default');
  if (readTextFileSafe(fs, defaultPath) !== String(accountId)) return false;
  return removeFileSafe(fs, defaultPath);
}

function clearCodexDesktopPointerIfNeeded(fs, aiHomeDir, accountId) {
  const statePath = path.join(aiHomeDir, 'codex-desktop-hook-state.json');
  const state = readJsonFileSafe(fs, statePath);
  if (!state || String(state.desktopAccountId || '').trim() !== String(accountId)) return false;
  delete state.desktopAccountId;
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (_error) {
    return false;
  }
}

function deleteProfileDir(fs, profileDir) {
  try {
    if (!profileDir || !fs.existsSync(profileDir)) return false;
    fs.rmSync(profileDir, { recursive: true, force: true });
    return true;
  } catch (_error) {
    return false;
  }
}

function deleteSelfRelayAccounts(options = {}) {
  const {
    fs,
    profilesDir,
    getProfileDir,
    getToolConfigDir,
    checkStatus,
    accountStateIndex,
    accountStateService
  } = options;
  const serverPort = normalizeServerPort(
    options.serverPort
    || (typeof options.readServerConfig === 'function' ? (options.readServerConfig() || {}).port : 0)
  );
  const root = String(profilesDir || '').trim();
  if (!fs || !root || !Number.isFinite(serverPort) || serverPort <= 0) {
    return { deleted: [], serverPort };
  }
  const aiHomeDir = String(options.aiHomeDir || path.dirname(root)).trim();
  const deleted = [];
  const providers = (Array.isArray(options.providers) && options.providers.length > 0
    ? options.providers
    : ACCOUNT_PROVIDERS
  ).map(normalizeProvider).filter(Boolean);

  providers.forEach((provider) => {
    collectCandidateAccountIds({ fs, profilesDir: root, accountStateIndex, provider }).forEach((accountId) => {
      const profileDir = typeof getProfileDir === 'function'
        ? getProfileDir(provider, accountId)
        : path.join(root, provider, accountId);
      const configDir = typeof getToolConfigDir === 'function'
        ? getToolConfigDir(provider, accountId)
        : resolveConfigDir(provider, profileDir);
      const status = typeof checkStatus === 'function' ? (checkStatus(provider, profileDir) || {}) : {};
      const info = readApiKeyProfileInfo({
        fs,
        provider,
        profileDir,
        configDir,
        accountName: status.accountName
      });
      if (!isSelfRelayApiKeyInfo(info, serverPort)) return;

      const profileDeleted = deleteProfileDir(fs, profileDir);
      const stateDeleted = accountStateService && typeof accountStateService.deleteAccount === 'function'
        ? accountStateService.deleteAccount(provider, accountId)
        : false;
      clearDefaultPointerIfNeeded(fs, root, provider, accountId);
      if (provider === 'codex' && aiHomeDir) clearCodexDesktopPointerIfNeeded(fs, aiHomeDir, accountId);
      deleted.push({
        provider,
        accountId,
        baseUrl: info.baseUrl,
        profileDeleted,
        stateDeleted
      });
    });
  });

  return { deleted, serverPort };
}

module.exports = {
  AIH_SERVER_PROFILE_ID,
  ACCOUNT_PROVIDERS,
  buildAihServerBaseUrl,
  buildAihServerProfileEnv,
  deleteSelfRelayAccounts,
  isAihServerProfileId,
  isSelfRelayApiKeyInfo,
  isSelfRelayApiKeyProfile,
  normalizeServerHost,
  normalizeServerPort,
  readApiKeyProfileInfo,
  supportsAihServerProfile
};
