'use strict';

const nodePath = require('node:path');

// Public platform identifiers. Provider contracts, WebUI payloads and installer
// descriptors use these values; Node/OS-specific identifiers stay inside the
// adapter boundary below.
const CLIENT_PLATFORMS = Object.freeze({
  MACOS: 'macos',
  WINDOWS: 'windows',
  LINUX: 'linux'
});

const PLATFORM_ALIASES = Object.freeze({
  mac: CLIENT_PLATFORMS.MACOS,
  macos: CLIENT_PLATFORMS.MACOS,
  darwin: CLIENT_PLATFORMS.MACOS,
  win: CLIENT_PLATFORMS.WINDOWS,
  windows: CLIENT_PLATFORMS.WINDOWS,
  win32: CLIENT_PLATFORMS.WINDOWS,
  linux: CLIENT_PLATFORMS.LINUX,
  linux2: CLIENT_PLATFORMS.LINUX
});

/**
 * @typedef {Object} ClientPlatformAdapter
 * @property {'macos'|'windows'|'linux'} id Public platform identifier.
 * @property {'darwin'|'win32'|'linux'} nodePlatform Private Node platform id.
 * @property {Object} path Platform-correct path implementation.
 * @property {Object} commands Platform-correct executable names.
 * @property {string} commands.npm Package-manager executable used by installers.
 * @property {string} commands.uv Optional uv executable used by provider installers.
 * @property {string} commands.shell Native script host used by the platform.
 * @property {string} [commands.cmd] Windows CMD host, private to Windows installers.
 */

function defineClientPlatformAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw new TypeError('client platform adapter must be an object');
  }
  const id = String(adapter.id || '').trim();
  if (!Object.values(CLIENT_PLATFORMS).includes(id)) {
    throw new TypeError(`unsupported client platform adapter: ${id || '(empty)'}`);
  }
  if (!adapter.path || typeof adapter.path.join !== 'function') {
    throw new TypeError(`client platform adapter ${id} must provide a path implementation`);
  }
  if (!adapter.commands || typeof adapter.commands !== 'object') {
    throw new TypeError(`client platform adapter ${id} must provide command names`);
  }
  return Object.freeze({
    id,
    nodePlatform: String(adapter.nodePlatform || '').trim(),
    path: adapter.path,
    commands: Object.freeze({ ...adapter.commands })
  });
}

// This is the only place that knows how the public interface maps to Node's
// platform identifiers and executable conventions.
const CLIENT_PLATFORM_ADAPTERS = Object.freeze({
  [CLIENT_PLATFORMS.MACOS]: defineClientPlatformAdapter({
    id: CLIENT_PLATFORMS.MACOS,
    nodePlatform: 'darwin',
    path: nodePath.posix,
    commands: { npm: 'npm', uv: 'uv', shell: 'bash' }
  }),
  [CLIENT_PLATFORMS.WINDOWS]: defineClientPlatformAdapter({
    id: CLIENT_PLATFORMS.WINDOWS,
    nodePlatform: 'win32',
    path: nodePath.win32,
    commands: { npm: 'npm.cmd', uv: 'uv.exe', shell: 'powershell.exe', cmd: 'cmd.exe' }
  }),
  [CLIENT_PLATFORMS.LINUX]: defineClientPlatformAdapter({
    id: CLIENT_PLATFORMS.LINUX,
    nodePlatform: 'linux',
    path: nodePath.posix,
    commands: { npm: 'npm', uv: 'uv', shell: 'bash' }
  })
});

function normalizeClientPlatform(value, fallback = '') {
  const candidate = String(value == null ? '' : value).trim().toLowerCase();
  if (candidate && PLATFORM_ALIASES[candidate]) return PLATFORM_ALIASES[candidate];
  if (fallback === value) return '';
  return fallback ? normalizeClientPlatform(fallback) : '';
}

function resolveClientPlatform(options = {}) {
  const processObj = options.processObj || process;
  return normalizeClientPlatform(options.platform || processObj.platform || process.platform);
}

function getClientPlatformAdapter(valueOrOptions = {}) {
  const platform = typeof valueOrOptions === 'string'
    ? normalizeClientPlatform(valueOrOptions)
    : resolveClientPlatform(valueOrOptions);
  return CLIENT_PLATFORM_ADAPTERS[platform] || null;
}

function toNodePlatform(valueOrOptions = {}) {
  const adapter = getClientPlatformAdapter(valueOrOptions);
  return adapter ? adapter.nodePlatform : '';
}

module.exports = {
  CLIENT_PLATFORMS,
  CLIENT_PLATFORM_ADAPTERS,
  defineClientPlatformAdapter,
  normalizeClientPlatform,
  resolveClientPlatform,
  getClientPlatformAdapter,
  toNodePlatform
};
