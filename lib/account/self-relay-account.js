'use strict';

const { isLoopbackUrl } = require('../server/http-utils');
const {
  listAccountCredentialRecords
} = require('../server/account-credential-store');
const { createAccountRemovalService } = require('./account-removal');
const {
  DEFAULT_SERVER_PORT,
  buildServerBaseUrl,
  buildServerUrl,
  formatUrlHost,
  listSelfRelayPorts,
  normalizeServerHost: normalizeDefaultServerHost,
  normalizeServerPort: normalizeDefaultServerPort
} = require('../server/server-defaults');

const AIH_SERVER_PROFILE_ID = '.aih-server';
const AIH_SERVER_PROFILE_PROVIDERS = Object.freeze(['codex', 'claude', 'opencode']);
const ACCOUNT_PROVIDERS = Object.freeze(['codex', 'gemini', 'claude']);

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
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

function buildAihServerRootUrl(serverConfig = {}) {
  return buildServerUrl({
    host: formatUrlHost(serverConfig.host),
    port: normalizeServerPort(serverConfig.port)
  });
}

function buildAihServerProfileEnv(provider, serverConfig = {}) {
  const p = normalizeProvider(provider);
  if (!supportsAihServerProfile(p)) return null;
  const apiKey = String(serverConfig.apiKey || serverConfig.clientKey || '').trim() || 'dummy';
  if (p === 'codex') {
    return {
      OPENAI_API_KEY: apiKey,
      OPENAI_BASE_URL: buildAihServerBaseUrl(serverConfig)
    };
  }
  if (p === 'claude') {
    return {
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_BASE_URL: buildAihServerRootUrl(serverConfig)
    };
  }
  if (p === 'opencode') {
    // OpenCode routes via a generated OPENCODE_CONFIG overlay pointing the built-in
    // `anthropic` provider at the local gateway (keeping the host config + its
    // session-sync plugin intact). OpenAI-style /v1 base — opencode's anthropic
    // provider posts /v1/messages under it, which the gateway serves.
    return {
      AIH_OPENCODE_GATEWAY_BASE_URL: buildAihServerBaseUrl(serverConfig),
      AIH_OPENCODE_GATEWAY_KEY: apiKey
    };
  }
  return null;
}

function readCodexApiKeyInfo(credentials = {}) {
  const apiKey = String(credentials.OPENAI_API_KEY || '').trim();
  const baseUrl = String(credentials.OPENAI_BASE_URL || '').trim();
  return {
    apiKeyMode: Boolean(apiKey),
    apiKey,
    baseUrl
  };
}

function readClaudeApiKeyInfo(credentials = {}) {
  const apiKey = String(
    credentials.ANTHROPIC_API_KEY
    || credentials.ANTHROPIC_AUTH_TOKEN
    || ''
  ).trim();
  const baseUrl = String(credentials.ANTHROPIC_BASE_URL || '').trim();
  return {
    apiKeyMode: Boolean(apiKey),
    apiKey,
    baseUrl
  };
}

function readApiKeyAccountInfo(input = {}) {
  const provider = normalizeProvider(input.provider);
  const credentials = input.credentials && typeof input.credentials === 'object'
    ? input.credentials
    : {};
  if (provider === 'codex') {
    return readCodexApiKeyInfo(credentials);
  }
  if (provider === 'claude') {
    return readClaudeApiKeyInfo(credentials);
  }
  return { apiKeyMode: false, apiKey: '', baseUrl: '' };
}

function isSelfRelayApiKeyInfo(info, serverPort) {
  if (!info || !info.apiKeyMode || !info.baseUrl) return false;
  return listSelfRelayPorts(serverPort).some((port) => isLoopbackUrl(info.baseUrl, port));
}

function isSelfRelayApiKeyAccount(input = {}) {
  return isSelfRelayApiKeyInfo(readApiKeyAccountInfo(input), input.serverPort);
}

function deleteSelfRelayAccounts(options = {}) {
  const {
    fs,
    aiHomeDir,
    accountStateService
  } = options;
  const serverPort = normalizeServerPort(
    options.serverPort
    || (typeof options.readServerConfig === 'function' ? (options.readServerConfig() || {}).port : 0)
  );
  const storageDir = String(aiHomeDir || '').trim();
  if (!fs || !storageDir || !Number.isFinite(serverPort) || serverPort <= 0) {
    return { deleted: [], serverPort };
  }
  const accountRemovalService = createAccountRemovalService({
    ...options,
    fs,
    aiHomeDir: storageDir,
    accountStateService
  });
  const deleted = [];
  const providers = (Array.isArray(options.providers) && options.providers.length > 0
    ? options.providers
    : ACCOUNT_PROVIDERS
  ).map(normalizeProvider).filter(Boolean);

  providers.forEach((provider) => {
    listAccountCredentialRecords(fs, storageDir, provider).forEach((record) => {
      const info = readApiKeyAccountInfo({
        provider,
        credentials: record.env
      });
      if (!isSelfRelayApiKeyInfo(info, serverPort)) return;

      const removal = accountRemovalService.deleteAccountByRef(provider, record.accountRef);
      deleted.push({
        provider,
        accountRef: record.accountRef,
        baseUrl: info.baseUrl,
        accountDeleted: removal.deleted,
        stateDeleted: removal.stateDeleted
      });
    });
  });

  return { deleted, serverPort };
}

module.exports = {
  AIH_SERVER_PROFILE_ID,
  ACCOUNT_PROVIDERS,
  buildAihServerBaseUrl,
  buildAihServerRootUrl,
  buildAihServerProfileEnv,
  deleteSelfRelayAccounts,
  isAihServerProfileId,
  isSelfRelayApiKeyInfo,
  isSelfRelayApiKeyAccount,
  normalizeServerHost,
  normalizeServerPort,
  readApiKeyAccountInfo,
  supportsAihServerProfile
};
