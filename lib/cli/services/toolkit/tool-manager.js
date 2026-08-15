'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawnSync: systemSpawnSync } = require('node:child_process');
const { resolveCommandPath: defaultResolveCommandPath } = require('../../../runtime/command-path');
const { resolvePlatformPath } = require('../../../runtime/platform-path');
const { resolveHostHomeDir } = require('../../../runtime/host-home');
const {
  ToolkitConfigError,
  getConfigFormat,
  readManagedAppConfig,
  saveManagedAppConfig
} = require('./config-editor');

const TOOLKIT_TOOL_CATEGORIES = Object.freeze([
  Object.freeze({
    id: 'session-runtimes',
    label: '会话运行时',
    description: '管理 AIH 使用的终端复用器和持久会话后端。'
  }),
  Object.freeze({
    id: 'network-access',
    label: '网络接入与隧道',
    description: '管理反向隧道、Overlay 网络和 Cloudflare Edge Tunnel。'
  })
]);

const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'tmux', category: 'session-runtimes', name: 'tmux', role: 'POSIX/WSL 会话复用器',
    platforms: ['darwin', 'linux', 'win32'], commands: ['tmux'], versionArgs: [['-V'], ['--version']],
    capabilities: ['detect', 'version', 'sessions'], config: null
  }),
  Object.freeze({
    id: 'psmux', category: 'session-runtimes', name: 'psmux', role: 'Windows 原生 tmux 兼容运行时',
    platforms: ['win32'], commands: ['psmux'], versionArgs: [['-V'], ['--version']],
    capabilities: ['detect', 'version', 'sessions'], config: null
  }),
  Object.freeze({
    id: 'herdr', category: 'session-runtimes', name: 'herdr', role: '后台 agent/终端运行时',
    platforms: ['darwin', 'linux', 'win32'], commands: ['herdr'], versionArgs: [['--version'], ['-V']],
    capabilities: ['detect', 'version', 'sessions'], config: null
  }),
  Object.freeze({
    id: 'frpc', category: 'network-access', name: 'frpc', role: 'FRP 客户端反向隧道',
    platforms: ['darwin', 'linux', 'win32'], commands: ['frpc'], versionArgs: [['--version'], ['-v']],
    capabilities: ['detect', 'version', 'config-edit'], config: { name: 'frpc.toml', format: 'toml' }
  }),
  Object.freeze({
    id: 'frps', category: 'network-access', name: 'frps', role: 'FRP 服务端反向隧道',
    platforms: ['darwin', 'linux', 'win32'], commands: ['frps'], versionArgs: [['--version'], ['-v']],
    capabilities: ['detect', 'version', 'config-edit'], config: { name: 'frps.toml', format: 'toml' }
  }),
  Object.freeze({
    id: 'tailscale', category: 'network-access', name: 'Tailscale', role: 'Overlay 网络客户端',
    platforms: ['darwin', 'linux', 'win32'], commands: ['tailscale'], versionArgs: [['version'], ['--version']],
    capabilities: ['detect', 'version', 'status', 'serve', 'funnel'], config: null
  }),
  Object.freeze({
    id: 'cloudflared', category: 'network-access', name: 'cloudflared', role: 'Cloudflare Tunnel connector',
    platforms: ['darwin', 'linux', 'win32'], commands: ['cloudflared'], versionArgs: [['version'], ['--version']],
    capabilities: ['detect', 'version', 'config-edit', 'config-validate'], config: { name: 'config.yml', format: 'yaml' }
  })
]);

const TOOL_BY_ID = new Map(TOOL_DEFINITIONS.map((definition) => [definition.id, definition]));

function resolvePlatform(options = {}) {
  const processObj = options.processObj || process;
  return String(options.platform || processObj.platform || process.platform).trim().toLowerCase();
}

function resolveEnv(options = {}) {
  const processObj = options.processObj || process;
  return options.env || processObj.env || process.env || {};
}

function resolveHome(options = {}) {
  if (String(options.hostHomeDir || '').trim()) return String(options.hostHomeDir).trim();
  try {
    return resolveHostHomeDir({
      env: resolveEnv(options),
      platform: resolvePlatform(options),
      os: options.os
    });
  } catch (_error) {
    const env = resolveEnv(options);
    return String(env.USERPROFILE || env.HOME || '').trim();
  }
}

function resolvePathApi(options = {}) {
  return resolvePlatformPath(resolvePlatform(options), options.path || nodePath);
}

function getToolDefinition(toolId) {
  const definition = TOOL_BY_ID.get(String(toolId || '').trim().toLowerCase());
  if (!definition) throw new ToolkitConfigError('unsupported_tool', `不支持管理工具 ${toolId || 'unknown'}`);
  return definition;
}

function parseVersion(output) {
  const text = String(output || '').trim();
  const match = text.match(/(?:^|[^0-9])v?(\d+(?:\.\d+){1,3}[A-Za-z][\w.-]*|\d+(?:\.\d+){1,3})(?=$|[^0-9A-Za-z])/i);
  return match ? match[1] : '';
}

function resolveCommand(definition, options = {}) {
  const platform = resolvePlatform(options);
  if (!definition.platforms.includes(platform)) return '';
  const env = resolveEnv(options);
  const resolvePath = options.resolveCommandPath || ((name) => defaultResolveCommandPath(name, {
    platform,
    env,
    spawnSyncImpl: options.spawnSync || systemSpawnSync
  }));
  for (const command of definition.commands) {
    try {
      const resolved = String(resolvePath(command, { platform, env }) || '').trim();
      if (resolved) return resolved;
    } catch (_error) {}
  }
  if (platform === 'win32' && definition.id === 'psmux') {
    return resolveWindowsPsmuxPath(options);
  }
  return '';
}

function probeVersion(definition, executablePath, options = {}) {
  if (!executablePath) return '';
  const spawnSync = options.spawnSync || systemSpawnSync;
  for (const args of definition.versionArgs) {
    try {
      const result = spawnSync(executablePath, args, {
        encoding: 'utf8', timeout: 3000, windowsHide: true
      });
      if (!result || result.status !== 0) continue;
      const parsed = parseVersion(`${result.stdout || ''}\n${result.stderr || ''}`);
      if (parsed) return parsed;
      const firstLine = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0];
      if (firstLine) return firstLine.slice(0, 64);
    } catch (_error) {}
  }
  return '';
}

function unique(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function resolveExistingOrFirst(candidates, fsImpl) {
  const normalized = unique(candidates);
  return normalized.find((candidate) => {
    try { return fsImpl.existsSync(candidate); } catch (_error) { return false; }
  }) || normalized[0] || '';
}

function resolveWindowsPsmuxPath(options = {}) {
  const env = resolveEnv(options);
  const pathImpl = resolvePathApi(options);
  const fsImpl = options.fs || nodeFs;
  const localAppData = env.LOCALAPPDATA || env.LocalAppData || env.localappdata || '';
  const userProfile = env.USERPROFILE || env.UserProfile || env.userprofile || '';
  const candidates = [
    localAppData && pathImpl.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'psmux.exe'),
    userProfile && pathImpl.join(userProfile, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'psmux.exe')
  ];
  return unique(candidates).find((candidate) => {
    try { return fsImpl.existsSync(candidate); } catch (_error) { return false; }
  }) || '';
}

function resolveFrpConfigPath(toolId, options = {}) {
  const platform = resolvePlatform(options);
  const env = resolveEnv(options);
  const home = resolveHome(options);
  const pathImpl = resolvePathApi(options);
  const fsImpl = options.fs || nodeFs;
  const role = toolId === 'frps' ? 'frps' : 'frpc';
  const explicit = env[`AIH_${role.toUpperCase()}_CONFIG`] || env[`${role.toUpperCase()}_CONFIG`];
  const appData = env.APPDATA || (home ? pathImpl.join(home, 'AppData', 'Roaming') : '');
  const programData = env.PROGRAMDATA || '';
  const candidates = [explicit];
  if (platform === 'win32') {
    candidates.push(
      programData && pathImpl.join(programData, 'frp', `${role}.toml`),
      appData && pathImpl.join(appData, 'frp', `${role}.toml`),
      home && pathImpl.join(home, '.config', 'frp', `${role}.toml`)
    );
  } else {
    candidates.push(
      home && pathImpl.join(home, '.config', 'frp', `${role}.toml`),
      `/etc/frp/${role}.toml`,
      `/etc/${role}.toml`
    );
  }
  return resolveExistingOrFirst(candidates, fsImpl);
}

function resolveCloudflaredConfigPath(options = {}) {
  const platform = resolvePlatform(options);
  const env = resolveEnv(options);
  const home = resolveHome(options);
  const pathImpl = resolvePathApi(options);
  const fsImpl = options.fs || nodeFs;
  const explicit = env.AIH_CLOUDFLARED_CONFIG || env.CLOUDFLARED_CONFIG;
  const candidates = [explicit];
  if (home) candidates.push(pathImpl.join(home, '.cloudflared', 'config.yml'));
  if (platform !== 'win32') candidates.push('/etc/cloudflared/config.yml');
  else {
    const programData = env.PROGRAMDATA || env.ProgramData || env.programdata || '';
    if (programData) candidates.push(pathImpl.join(programData, 'cloudflared', 'config.yml'));
  }
  return resolveExistingOrFirst(candidates, fsImpl);
}

function resolveToolConfigPath(toolId, options = {}) {
  if (toolId === 'frpc' || toolId === 'frps') return resolveFrpConfigPath(toolId, options);
  if (toolId === 'cloudflared') return resolveCloudflaredConfigPath(options);
  return '';
}

function canAccess(fsImpl, targetPath, mode) {
  try { fsImpl.accessSync(targetPath, mode); return true; } catch (_error) { return false; }
}

function inspectConfig(definition, options = {}) {
  if (!definition.config) {
    return { configName: '', configFormat: '', configExists: false, configWritable: false, requiresElevation: false, configEditable: false };
  }
  const fsImpl = options.fs || nodeFs;
  const pathImpl = resolvePathApi(options);
  const targetPath = resolveToolConfigPath(definition.id, options);
  const exists = Boolean(targetPath && fsImpl.existsSync(targetPath));
  const writable = targetPath
    ? canAccess(fsImpl, exists ? targetPath : pathImpl.dirname(targetPath), nodeFs.constants.W_OK)
    : false;
  return {
    configName: definition.config.name,
    configFormat: getConfigFormat(targetPath) || definition.config.format,
    configExists: exists,
    configWritable: writable,
    requiresElevation: !writable,
    configEditable: true
  };
}

function serviceManagerFor(platform) {
  if (platform === 'win32') return 'windows-service';
  if (platform === 'darwin') return 'launchd-or-homebrew';
  if (platform === 'linux') return 'systemd';
  return 'unknown';
}

function listManagedTools(options = {}) {
  const platform = resolvePlatform(options);
  const pathImpl = resolvePathApi(options);
  const tools = TOOL_DEFINITIONS.map((definition) => {
    const supported = definition.platforms.includes(platform);
    const executablePath = supported ? resolveCommand(definition, options) : '';
    const config = inspectConfig(definition, options);
    return {
      id: definition.id,
      category: definition.category,
      name: definition.name,
      role: definition.role,
      supported,
      installed: Boolean(executablePath),
      binaryName: executablePath ? pathImpl.basename(executablePath) : definition.commands[0],
      version: executablePath ? (probeVersion(definition, executablePath, options) || '未探测到') : '-',
      serviceManager: serviceManagerFor(platform),
      capabilities: definition.capabilities,
      ...config
    };
  });
  return {
    ok: true,
    platform,
    categories: TOOLKIT_TOOL_CATEGORIES,
    total: tools.length,
    installedCount: tools.filter((tool) => tool.installed).length,
    tools
  };
}

function assertEditableTool(toolId) {
  const definition = getToolDefinition(toolId);
  if (!definition.config) throw new ToolkitConfigError('tool_config_unsupported', `${definition.name} 没有可直接编辑的本地配置文件`);
  return definition;
}

function configOptions(toolId, options = {}) {
  const definition = assertEditableTool(toolId);
  const targetPath = resolveToolConfigPath(definition.id, options);
  if (!targetPath) throw new ToolkitConfigError('config_target_unavailable', '当前平台没有可解析的配置目标');
  return { ...options, targetPath };
}

function readManagedToolConfig(toolId, options = {}) {
  const normalized = String(toolId || '').trim().toLowerCase();
  return { ...readManagedAppConfig(normalized, configOptions(normalized, options)), toolId: normalized };
}

function saveManagedToolConfig(toolId, content, options = {}) {
  const normalized = String(toolId || '').trim().toLowerCase();
  return { ...saveManagedAppConfig(normalized, content, configOptions(normalized, options)), toolId: normalized };
}

module.exports = {
  TOOLKIT_TOOL_CATEGORIES,
  TOOL_DEFINITIONS,
  getToolDefinition,
  parseVersion,
  resolveToolConfigPath,
  listManagedTools,
  readManagedToolConfig,
  saveManagedToolConfig
};
