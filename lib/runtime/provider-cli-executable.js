'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

function resolveKiroChatExecutable(cliPath, options) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const platform = options.platform || process.platform;
  const input = String(cliPath || '').trim();
  if (!['kiro-cli', 'kiro-cli.exe'].includes(path.basename(input).toLowerCase())) return input;
  let resolved = input;
  try { resolved = fs.realpathSync(input); } catch (_) {}
  const chat = path.join(path.dirname(resolved), platform === 'win32' ? 'kiro-cli-chat.exe' : 'kiro-cli-chat');
  try {
    const stat = fs.statSync(chat);
    if (!stat.isFile() || stat.size <= 0) return input;
    if (platform !== 'win32') fs.accessSync(chat, nodeFs.constants.X_OK);
    return chat;
  } catch (_) {
    return input;
  }
}

// Executable adaptation is shared by CLI launches, WebUI login and discovery.
// Keep this registry independent of launch profiles and installer wiring to
// avoid importing their dependency graph during native executable resolution.
const EXECUTABLE_ADAPTERS = Object.freeze({ kiro: resolveKiroChatExecutable });

function resolveProviderCliExecutable(provider, cliPath, options = {}) {
  const adapter = EXECUTABLE_ADAPTERS[String(provider || '').trim().toLowerCase()];
  return adapter ? adapter(cliPath, options) : cliPath;
}

module.exports = { resolveProviderCliExecutable };
