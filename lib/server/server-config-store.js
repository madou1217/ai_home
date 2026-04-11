'use strict';

const path = require('node:path');
const { ensureDirSync } = require('./fs-compat');

const DEFAULT_SERVER_CONFIG = {
  host: '127.0.0.1',
  port: 8317,
  apiKey: '',
  managementKey: '',
  openNetwork: false
};

function getServerConfigPath(aiHomeDir) {
  const root = String(aiHomeDir || '').trim();
  return root ? path.join(root, 'server-config.json') : '';
}

function sanitizeServerConfig(input = {}) {
  const requestedHost = String(
    input.host === undefined || input.host === null
      ? DEFAULT_SERVER_CONFIG.host
      : input.host
  ).trim();
  const host = requestedHost && requestedHost !== '0.0.0.0'
    ? requestedHost
    : DEFAULT_SERVER_CONFIG.host;
  const parsedPort = Number(input.port);
  const port = Number.isFinite(parsedPort)
    ? Math.max(1, Math.min(65535, parsedPort))
    : DEFAULT_SERVER_CONFIG.port;
  const apiKey = String(input.apiKey === undefined || input.apiKey === null ? '' : input.apiKey).trim();
  const managementKey = String(
    input.managementKey === undefined || input.managementKey === null ? '' : input.managementKey
  ).trim();
  const openNetwork = Boolean(input.openNetwork) || requestedHost === '0.0.0.0';
  return {
    host: openNetwork ? '0.0.0.0' : host,
    port,
    apiKey,
    managementKey,
    openNetwork
  };
}

function readServerConfig(deps = {}) {
  const { fs, aiHomeDir } = deps;
  const filePath = getServerConfigPath(aiHomeDir);
  if (!filePath || !fs || !fs.existsSync(filePath)) {
    return { ...DEFAULT_SERVER_CONFIG };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return sanitizeServerConfig(parsed);
  } catch (_error) {
    return { ...DEFAULT_SERVER_CONFIG };
  }
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
  const filePath = getServerConfigPath(aiHomeDir);
  if (!filePath || !fs) return { ...DEFAULT_SERVER_CONFIG };
  const normalized = mergeServerConfigPatch(readServerConfig(deps), config);
  ensureDirSync(fs, path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2));
  return normalized;
}

function buildServerArgsFromConfig(config = {}) {
  const normalized = sanitizeServerConfig(config);
  const args = [
    '--host', normalized.host,
    '--port', String(normalized.port)
  ];
  if (normalized.apiKey) args.push('--api-key', normalized.apiKey);
  if (normalized.managementKey) args.push('--management-key', normalized.managementKey);
  return args;
}

module.exports = {
  DEFAULT_SERVER_CONFIG,
  sanitizeServerConfig,
  mergeServerConfigPatch,
  readServerConfig,
  writeServerConfig,
  buildServerArgsFromConfig
};
