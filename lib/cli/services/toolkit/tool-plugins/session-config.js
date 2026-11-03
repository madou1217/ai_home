'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolvePlatformPath } = require('../../../../runtime/platform-path');
const { resolveEnv, resolveHostHome, resolvePlatform } = require('../tool-lifecycle/shared');

function tmuxConfigPath(options = {}) {
  const p = resolvePlatformPath(resolvePlatform(options), options.path || path);
  const home = resolveHostHome(options);
  if (!home) return '';
  const env = resolveEnv(options);
  const candidates = [p.join(home, '.tmux.conf'), p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'tmux', 'tmux.conf')];
  return candidates.find((candidate) => (options.fs || fs).existsSync(candidate)) || candidates[0];
}

function herdrConfigPath(options = {}) {
  const p = resolvePlatformPath(resolvePlatform(options), options.path || path);
  const home = resolveHostHome(options);
  if (!home) return '';
  const env = resolveEnv(options);
  const override = String(env.HERDR_CONFIG_PATH || '').trim();
  if (override) return p.isAbsolute(override) ? override : p.resolve(override);
  const root = resolvePlatform(options) === 'win32'
    ? env.APPDATA || p.join(home, 'AppData', 'Roaming')
    : env.XDG_CONFIG_HOME || p.join(home, '.config');
  return p.join(root, 'herdr', 'config.toml');
}

function validateToml(content) {
  try { require('smol-toml').parse(String(content || '')); return { ok: true }; }
  catch (error) { return { ok: false, message: error.message }; }
}

module.exports = { herdrConfigPath, tmuxConfigPath, validateToml };
