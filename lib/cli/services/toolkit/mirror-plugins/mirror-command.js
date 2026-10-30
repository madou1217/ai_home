'use strict';

const { execFile: nodeExecFile, spawnSync: nodeSpawnSync } = require('node:child_process');

function execCommand(cmd, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSync || nodeSpawnSync;
  try {
    const res = spawnSyncImpl(cmd, args, {
      encoding: 'utf8',
      timeout: options.commandTimeoutMs || 5000,
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

// Non-blocking variant with the same result shape. With an injected spawnSync (tests /
// embedders) it defers to execCommand so the injected environment is still honoured.
function execCommandAsync(cmd, args = [], options = {}) {
  if (options.spawnSync && options.spawnSync !== nodeSpawnSync) {
    return Promise.resolve().then(() => execCommand(cmd, args, options));
  }
  return new Promise((resolve) => {
    try {
      nodeExecFile(cmd, args, {
        encoding: 'utf8',
        timeout: options.commandTimeoutMs || 5000,
        windowsHide: true
      }, (error, stdout, stderr) => {
        const status = error ? (Number.isInteger(error.code) ? error.code : null) : 0;
        resolve({
          ok: !error,
          status,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || (error && !Number.isInteger(error.code) ? error.message : '') || '').trim()
        });
      });
    } catch (e) {
      resolve({ ok: false, status: null, stdout: '', stderr: e.message });
    }
  });
}

function parseHttpUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed;
  } catch (_error) {
    return null;
  }
}

module.exports = {
  execCommand,
  execCommandAsync,
  parseHttpUrl
};
