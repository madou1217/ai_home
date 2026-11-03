'use strict';

const childProcess = require('node:child_process');

const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function parseRegistryValue(output, name) {
  const pattern = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'im');
  const match = String(output || '').match(pattern);
  return match ? String(match[1] || '').trim() : '';
}

function normalizeProxyUrl(value, scheme = 'http') {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) return normalized;
  return `${scheme}://${normalized}`;
}

function parseWindowsProxyServer(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return {};
  if (!normalized.includes('=')) {
    const proxyUrl = normalizeProxyUrl(normalized);
    return proxyUrl ? { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl } : {};
  }
  const entries = {};
  normalized.split(';').forEach((segment) => {
    const separator = segment.indexOf('=');
    if (separator <= 0) return;
    const protocol = segment.slice(0, separator).trim().toLowerCase();
    const address = segment.slice(separator + 1).trim();
    if (!address) return;
    if (protocol === 'http') entries.HTTP_PROXY = normalizeProxyUrl(address);
    if (protocol === 'https') entries.HTTPS_PROXY = normalizeProxyUrl(address);
    if (protocol === 'socks' || protocol === 'socks5') entries.ALL_PROXY = normalizeProxyUrl(address, 'socks5');
  });
  if (!entries.HTTPS_PROXY && entries.HTTP_PROXY) entries.HTTPS_PROXY = entries.HTTP_PROXY;
  return entries;
}

function readWindowsSystemProxy(options = {}) {
  if (String(options.platform || process.platform) !== 'win32') return {};
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  try {
    const output = execFileSync('reg.exe', ['query', INTERNET_SETTINGS_KEY], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const enabled = parseInt(parseRegistryValue(output, 'ProxyEnable'), 16);
    if (enabled !== 1) return {};
    return parseWindowsProxyServer(parseRegistryValue(output, 'ProxyServer'));
  } catch (_error) {
    return {};
  }
}

function applyWindowsSystemProxy(envObj, options = {}) {
  const env = { ...(envObj || {}) };
  const hasExplicitProxy = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
    .some((key) => String(env[key] || '').trim());
  if (hasExplicitProxy) return env;
  return { ...env, ...readWindowsSystemProxy(options) };
}

module.exports = {
  applyWindowsSystemProxy,
  parseWindowsProxyServer,
  readWindowsSystemProxy
};
