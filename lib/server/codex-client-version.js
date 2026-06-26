'use strict';

const { execFileSync } = require('node:child_process');

function parseCodexClientVersion(value) {
  const match = String(value || '').match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

function resolveCodexCommand(options = {}) {
  const explicit = String(options.codexCommand || '').trim();
  if (explicit) return explicit;

  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const fromEnv = String(env.AIH_CODEX_BIN || '').trim();
  if (fromEnv) return fromEnv;

  if (typeof options.resolveCliPath === 'function') {
    try {
      const resolved = String(options.resolveCliPath('codex') || '').trim();
      if (resolved) return resolved;
    } catch (_error) {}
  }

  return 'codex';
}

function detectCodexClientVersion(options = {}) {
  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const configured = parseCodexClientVersion(
    options.codexClientVersion
    || env.AIH_SERVER_CODEX_CLIENT_VERSION
    || env.AIH_CODEX_CLIENT_VERSION
    || ''
  );
  if (configured) return configured;

  const command = resolveCodexCommand(options);
  try {
    const raw = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: Math.max(250, Number(options.timeoutMs) || 1000),
      env
    });
    return parseCodexClientVersion(raw);
  } catch (_error) {
    return '';
  }
}

module.exports = {
  detectCodexClientVersion,
  parseCodexClientVersion,
  resolveCodexCommand
};
