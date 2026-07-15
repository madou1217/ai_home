'use strict';

const {
  readJsonValue,
  writeJsonValue
} = require('./app-state-store');
const {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  normalizeServerPort
} = require('./server-defaults');

const DEFAULT_SERVER_CONFIG = {
  host: DEFAULT_SERVER_HOST,
  port: DEFAULT_SERVER_PORT,
  apiKey: '',
  managementKey: '',
  openNetwork: false,
  proxyUrl: '',
  noProxy: '',
  modelsProbeAccounts: 2
};
const SERVER_CONFIG_KEY = 'config:server';

function sanitizeServerConfig(input = {}) {
  const requestedHost = String(
    input.host === undefined || input.host === null
      ? DEFAULT_SERVER_CONFIG.host
      : input.host
  ).trim();
  const host = requestedHost && requestedHost !== '0.0.0.0'
    ? requestedHost
    : DEFAULT_SERVER_CONFIG.host;
  const port = normalizeServerPort(input.port, DEFAULT_SERVER_CONFIG.port);
  const apiKey = String(input.apiKey === undefined || input.apiKey === null ? '' : input.apiKey).trim();
  const managementKey = String(
    input.managementKey === undefined || input.managementKey === null ? '' : input.managementKey
  ).trim();
  const openNetwork = Boolean(input.openNetwork) || requestedHost === '0.0.0.0';
  const proxyUrl = String(input.proxyUrl === undefined || input.proxyUrl === null ? '' : input.proxyUrl).trim();
  const noProxy = String(input.noProxy === undefined || input.noProxy === null ? '' : input.noProxy).trim();
  const modelsProbeAccounts = Math.max(1, Math.min(8, Number(input.modelsProbeAccounts) || 2));
  return {
    host: openNetwork ? '0.0.0.0' : host,
    port,
    apiKey,
    managementKey,
    openNetwork,
    proxyUrl,
    noProxy,
    modelsProbeAccounts
  };
}

function readServerConfig(deps = {}) {
  const { fs, aiHomeDir } = deps;
  if (!fs || !String(aiHomeDir || '').trim()) return { ...DEFAULT_SERVER_CONFIG };
  const stored = readJsonValue(fs, aiHomeDir, SERVER_CONFIG_KEY);
  return stored && typeof stored === 'object'
    ? sanitizeServerConfig(stored)
    : { ...DEFAULT_SERVER_CONFIG };
}

function mergeServerConfigPatch(currentConfig, patch) {
  const base = sanitizeServerConfig(currentConfig);
  const next = { ...base };
  const input = patch && typeof patch === 'object' ? patch : {};

  for (const key of Object.keys(DEFAULT_SERVER_CONFIG)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = input[key];
    if (value === undefined || value === null) continue;
    next[key] = value;
  }

  if (
    Object.prototype.hasOwnProperty.call(input, 'openNetwork')
    && input.openNetwork === false
    && (input.host === undefined || input.host === null)
    && next.host === '0.0.0.0'
  ) {
    next.host = DEFAULT_SERVER_CONFIG.host;
  }

  return sanitizeServerConfig(next);
}

function writeServerConfig(config, deps = {}) {
  const { fs, aiHomeDir } = deps;
  if (!fs || !String(aiHomeDir || '').trim()) return { ...DEFAULT_SERVER_CONFIG };
  const normalized = mergeServerConfigPatch(readServerConfig(deps), config);
  if (!writeJsonValue(fs, aiHomeDir, SERVER_CONFIG_KEY, normalized)) {
    throw new Error('server_config_write_failed');
  }
  return normalized;
}

function buildServerArgsFromConfig(config = {}) {
  const normalized = sanitizeServerConfig(config);
  const args = [
    '--host', normalized.host,
    '--port', String(normalized.port)
  ];
  if (normalized.proxyUrl) args.push('--proxy-url', normalized.proxyUrl);
  if (normalized.noProxy) args.push('--no-proxy', normalized.noProxy);
  if (normalized.modelsProbeAccounts !== DEFAULT_SERVER_CONFIG.modelsProbeAccounts) {
    args.push('--models-probe-accounts', String(normalized.modelsProbeAccounts));
  }
  return args;
}

module.exports = {
  DEFAULT_SERVER_CONFIG,
  SERVER_CONFIG_KEY,
  sanitizeServerConfig,
  mergeServerConfigPatch,
  readServerConfig,
  writeServerConfig,
  buildServerArgsFromConfig
};
