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

const CLIENT_ARCHITECTURES = Object.freeze({
  X64: 'x64',
  ARM64: 'arm64',
  X86: 'x86',
  UNKNOWN: 'unknown'
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

const ARCHITECTURE_ALIASES = Object.freeze({
  x64: CLIENT_ARCHITECTURES.X64,
  amd64: CLIENT_ARCHITECTURES.X64,
  x86_64: CLIENT_ARCHITECTURES.X64,
  'x86-64': CLIENT_ARCHITECTURES.X64,
  arm64: CLIENT_ARCHITECTURES.ARM64,
  aarch64: CLIENT_ARCHITECTURES.ARM64,
  armv8: CLIENT_ARCHITECTURES.ARM64,
  x86: CLIENT_ARCHITECTURES.X86,
  ia32: CLIENT_ARCHITECTURES.X86,
  i386: CLIENT_ARCHITECTURES.X86
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

function normalizeClientArchitecture(value, fallback = CLIENT_ARCHITECTURES.UNKNOWN) {
  const candidate = String(value == null ? '' : value).trim().toLowerCase();
  if (candidate && ARCHITECTURE_ALIASES[candidate]) return ARCHITECTURE_ALIASES[candidate];
  if (fallback === value) return CLIENT_ARCHITECTURES.UNKNOWN;
  return fallback ? normalizeClientArchitecture(fallback) : CLIENT_ARCHITECTURES.UNKNOWN;
}

function resolveClientPlatform(options = {}) {
  const processObj = options.processObj || process;
  return normalizeClientPlatform(options.platform || processObj.platform || process.platform);
}

function resolveClientArchitecture(options = {}) {
  const processObj = options.processObj || process;
  const env = processObj.env || process.env || {};
  const requestedPlatform = options.platform ? normalizeClientPlatform(options.platform) : '';
  const hostPlatform = normalizeClientPlatform(processObj.platform || process.platform);
  if (requestedPlatform && requestedPlatform !== hostPlatform && !options.arch) {
    return CLIENT_ARCHITECTURES.UNKNOWN;
  }
  const raw = options.arch
    || env.PROCESSOR_ARCHITEW6432
    || env.PROCESSOR_ARCHITECTURE
    || processObj.arch
    || '';
  return normalizeClientArchitecture(raw);
}

/**
 * 返回当前目标架构是否在 Provider 声明的支持范围内。
 * 跨目标规划没有可靠架构信息时保留计划，真正执行时仍由官方安装器校验。
 * @param {Object} options
 * @param {string[]} supportedArchitectures
 * @returns {boolean}
 */
function isClientArchitectureSupported(options = {}, supportedArchitectures = []) {
  const architecture = resolveClientArchitecture(options);
  if (architecture === CLIENT_ARCHITECTURES.UNKNOWN) return true;
  const supported = new Set((Array.isArray(supportedArchitectures) ? supportedArchitectures : [])
    .map((value) => normalizeClientArchitecture(value)));
  return supported.has(architecture);
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
  CLIENT_ARCHITECTURES,
  CLIENT_PLATFORM_ADAPTERS,
  defineClientPlatformAdapter,
  normalizeClientPlatform,
  normalizeClientArchitecture,
  resolveClientPlatform,
  resolveClientArchitecture,
  isClientArchitectureSupported,
  getClientPlatformAdapter,
  toNodePlatform
};
