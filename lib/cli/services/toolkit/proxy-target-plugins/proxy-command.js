'use strict';

const { spawnSync: nodeSpawnSync } = require('node:child_process');

function execCommand(cmd, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSync || nodeSpawnSync;
  try {
    const res = spawnSyncImpl(cmd, args, {
      encoding: 'utf8',
      timeout: options.commandTimeoutMs || 4000,
      windowsHide: true
    });
    return {
      ok: Boolean(res) && res.status === 0,
      status: res && Number.isInteger(res.status) ? res.status : null,
      stdout: String(res && res.stdout || '').trim(),
      stderr: String(res && res.stderr || '').trim()
    };
  } catch (e) {
    return { ok: false, status: null, stdout: '', stderr: e.message };
  }
}

function parseProxyUrl(proxyUrl, { localHttpOnly = false } = {}) {
  const raw = String(proxyUrl || '').trim();
  if (!raw || raw.length > 2048) return null;
  try {
    const parsed = new URL(raw);
    const protocols = localHttpOnly ? ['http:', 'https:'] : ['http:', 'https:', 'socks:', 'socks4:', 'socks5:'];
    if (!protocols.includes(parsed.protocol) || parsed.username || parsed.password) return null;
    if (localHttpOnly) {
      const host = parsed.hostname.toLowerCase();
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return null;
      if (!parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    }
    return parsed;
  } catch (_error) {
    return null;
  }
}

function summarizeOperations(operations) {
  const failed = operations.find((operation) => !operation.ok);
  return {
    ok: !failed,
    error: failed ? 'proxy_config_failed' : null,
    message: failed ? (failed.stderr || `${failed.key} 配置失败`) : '',
    operations
  };
}

module.exports = {
  execCommand,
  parseProxyUrl,
  summarizeOperations
};
