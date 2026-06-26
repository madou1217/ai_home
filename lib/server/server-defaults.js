'use strict';

const DEFAULT_SERVER_HOST = '127.0.0.1';
const DEFAULT_SERVER_PORT = 9527;
const DEFAULT_SERVER_API_KEY = 'dummy';
// 8317 只用于识别历史自中继账号，运行默认端口固定为 9527。
const LEGACY_SERVER_PORTS = Object.freeze([8317]);

function normalizeServerPort(value, fallback = DEFAULT_SERVER_PORT) {
  const port = Number(value);
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  const fallbackPort = Number(fallback);
  if (Number.isInteger(fallbackPort) && fallbackPort > 0 && fallbackPort <= 65535) return fallbackPort;
  return DEFAULT_SERVER_PORT;
}

function normalizeServerHost(value, options = {}) {
  const host = String(value || '').trim();
  if (!host || host === '0.0.0.0') return DEFAULT_SERVER_HOST;
  if (options.loopbackOnly && host === '::') return DEFAULT_SERVER_HOST;
  return host;
}

function formatUrlHost(host) {
  const normalized = normalizeServerHost(host);
  return normalized.includes(':') && !normalized.startsWith('[') ? `[${normalized}]` : normalized;
}

function normalizeUrlPath(pathname) {
  const value = String(pathname || '').trim();
  if (!value) return '';
  return value.startsWith('/') ? value : `/${value}`;
}

function buildServerUrl(config = {}, pathname = '') {
  const host = formatUrlHost(config.host);
  const port = normalizeServerPort(config.port);
  return `http://${host}:${port}${normalizeUrlPath(pathname)}`;
}

function buildServerBaseUrl(config = {}) {
  return buildServerUrl(config, '/v1');
}

function buildManagementBaseUrl(config = {}) {
  return buildServerUrl(config, '/v0/management');
}

function listSelfRelayPorts(currentPort) {
  const ports = new Set();
  const normalizedCurrentPort = normalizeServerPort(currentPort);
  if (normalizedCurrentPort) ports.add(normalizedCurrentPort);
  LEGACY_SERVER_PORTS.forEach((port) => ports.add(port));
  return Array.from(ports);
}

module.exports = {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  DEFAULT_SERVER_API_KEY,
  LEGACY_SERVER_PORTS,
  normalizeServerPort,
  normalizeServerHost,
  formatUrlHost,
  buildServerUrl,
  buildServerBaseUrl,
  buildManagementBaseUrl,
  listSelfRelayPorts
};
