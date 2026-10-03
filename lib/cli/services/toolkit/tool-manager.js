'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawnSync: systemSpawnSync } = require('node:child_process');
const { resolveCommandPath: defaultResolveCommandPath } = require('../../../runtime/command-path');
const { resolvePlatformPath } = require('../../../runtime/platform-path');
const {
  normalizeClientPlatform,
  toNodePlatform
} = require('../../../runtime/client-platform');
const {
  ToolkitConfigError,
  getConfigFormat,
  readManagedAppConfig,
  saveManagedAppConfig
} = require('./config-editor');
const {
  discoverNetworkTools,
  resolveNetworkToolConfigPath
} = require('./network-tool-discovery');
const {
  TOOL_PLUGINS,
  getToolPlugin,
  listToolPlugins
} = require('./tool-plugins');

const TOOL_TARGET_TOKEN_KEY = crypto.randomBytes(32);

const TOOLKIT_TOOL_CATEGORIES = Object.freeze([
  Object.freeze({
    id: 'session-runtimes',
    label: '会话运行时',
    description: '管理 AIH 使用的终端复用器和持久会话后端。'
  }),
  Object.freeze({
    id: 'network-access',
    label: '网络接入与隧道',
    description: '管理 AIH 使用的 frpc 客户端反向隧道配置。'
  })
]);

const TOOL_DEFINITIONS = TOOL_PLUGINS;

const NO_LIFECYCLE = Object.freeze({
  managedBy: '',
  canInstall: false,
  canUpdate: false,
  canUninstall: false,
  lifecycle: Object.freeze({ install: false, update: false, uninstall: false })
});

function resolvePlatform(options = {}) {
  const processObj = options.processObj || process;
  return toNodePlatform(
    normalizeClientPlatform(options.platform || processObj.platform || process.platform)
  );
}

function resolveEnv(options = {}) {
  const processObj = options.processObj || process;
  return options.env || processObj.env || process.env || {};
}

function resolvePathApi(options = {}) {
  return resolvePlatformPath(resolvePlatform(options), options.path || nodePath);
}

function getToolDefinition(toolId) {
  const definition = getToolPlugin(toolId);
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
  return typeof definition.resolveExecutableFallback === 'function'
    ? String(definition.resolveExecutableFallback(options) || '')
    : '';
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

function resolveToolConfigPath(toolId, options = {}) {
  return resolveNetworkToolConfigPath(toolId, options);
}

function canAccess(fsImpl, targetPath, mode) {
  try { fsImpl.accessSync(targetPath, mode); return true; } catch (_error) { return false; }
}

function inspectConfig(definition, options = {}) {
  if (!definition.config) {
    return {
      configName: '',
      configFormat: '',
      configExists: false,
      configWritable: false,
      requiresElevation: false,
      configEditable: false,
      configCount: 0,
      configAmbiguous: false,
      configState: 'none'
    };
  }
  const fsImpl = options.fs || nodeFs;
  const pathImpl = resolvePathApi(options);
  const networkRuntime = options.networkRuntime || {};
  const runtime = networkRuntime[definition.id] || {};
  const targetPath = String(runtime.configPath || resolveToolConfigPath(definition.id, options) || '');
  const exists = Boolean(targetPath && fsImpl.existsSync(targetPath));
  const writable = targetPath
    ? canAccess(fsImpl, exists ? targetPath : pathImpl.dirname(targetPath), nodeFs.constants.W_OK)
    : false;
  return {
    configName: exists ? pathImpl.basename(targetPath) : '',
    configFormat: targetPath ? getConfigFormat(targetPath) : definition.config.format,
    configExists: exists,
    configWritable: writable,
    requiresElevation: Boolean(targetPath && !writable),
    configEditable: Boolean(exists && !runtime.configAmbiguous),
    configCount: Number(runtime.configCount || (exists ? 1 : 0)),
    configAmbiguous: Boolean(runtime.configAmbiguous),
    configState: String(runtime.configState || (exists ? 'single' : 'none'))
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
  const networkRuntime = options.networkRuntime || discoverNetworkTools(options);
  const tools = listToolPlugins(platform).map((definition) => {
    const runtime = networkRuntime[definition.id] || {};
    const resolvedCommand = resolveCommand(definition, options);
    const preferred = typeof definition.preferredExecutable === 'function'
      ? String(definition.preferredExecutable(options) || '')
      : '';
    const executablePath = preferred
      || resolvedCommand
      || (runtime.executableExists || runtime.running ? String(runtime.executablePath || '').trim() : '')
      || '';
    const config = inspectConfig(definition, { ...options, networkRuntime });
    const runtimeInspectable = Boolean(definition.runtimeInspectable);
    const tool = {
      id: definition.id,
      category: definition.category,
      name: definition.name,
      role: definition.role,
      supported: true,
      installed: Boolean(executablePath || (runtimeInspectable && runtime.running)),
      executablePath,
      binaryName: executablePath ? pathImpl.basename(executablePath) : definition.commands[0],
      version: executablePath ? (probeVersion(definition, executablePath, options) || '未探测到') : '-',
      serviceManager: serviceManagerFor(platform),
      capabilities: definition.capabilities,
      runtimeInspectable,
      running: runtimeInspectable ? Boolean(runtime.running) : false,
      runningCount: runtimeInspectable ? Number(runtime.runningCount || 0) : 0,
      startupManaged: runtimeInspectable ? Boolean(runtime.startupManaged) : false,
      startupSources: runtimeInspectable ? runtime.startupSources || [] : [],
      configSource: runtimeInspectable ? String(runtime.configSource || '') : '',
      ...config
    };
    const lifecycle = definition.lifecycle
      ? definition.lifecycle.describe(tool, options)
      : { ...NO_LIFECYCLE, executablePath: tool.executablePath };
    return {
      ...tool,
      ...lifecycle
    };
  });
  return {
    ok: true,
    platform: normalizeClientPlatform(platform),
    categories: TOOLKIT_TOOL_CATEGORIES,
    total: tools.length,
    installedCount: tools.filter((tool) => tool.installed).length,
    tools
  };
}

function planManagedToolAction(input = {}, options = {}) {
  const toolId = String(input.toolId || '').trim().toLowerCase();
  const plugin = getToolPlugin(toolId);
  const tool = listManagedTools(options).tools.find((item) => item.id === toolId) || null;
  if (!tool) return { ok: false, error: 'managed_tool_not_found', message: '工具不存在或不适用于当前系统。' };
  if (!plugin || !plugin.lifecycle) {
    return { ok: false, error: 'managed_tool_action_unavailable', message: `${tool.name} 不提供自动安装管理。` };
  }
  return plugin.lifecycle.resolvePlans(tool, input.action, options);
}

function assertEditableTool(toolId) {
  const definition = getToolDefinition(toolId);
  if (!definition.config) throw new ToolkitConfigError('tool_config_unsupported', `${definition.name} 没有可直接编辑的本地配置文件`);
  return definition;
}

function configOptions(toolId, options = {}) {
  const definition = assertEditableTool(toolId);
  const runtime = (options.networkRuntime || discoverNetworkTools(options))[definition.id] || {};
  if (runtime.configState === 'unresolved') {
    throw new ToolkitConfigError(
      'config_target_unresolved',
      `${definition.name} 运行或启动参数指向的配置当前无法安全读取`
    );
  }
  if (runtime.configAmbiguous) {
    throw new ToolkitConfigError(
      'config_target_ambiguous',
      `发现多个 ${definition.name} 配置文件，无法在隐藏路径的前提下安全确定编辑目标`
    );
  }
  const targetPath = String(runtime.configPath || '');
  if (!targetPath) throw new ToolkitConfigError('config_target_unavailable', '当前平台没有可解析的配置目标');
  return { ...options, targetPath };
}

function targetRevision(targetPath, options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = resolvePathApi(options);
  let identity = String(targetPath || '').trim();
  try {
    if (identity && typeof fsImpl.realpathSync === 'function') identity = fsImpl.realpathSync(identity);
  } catch (_error) {}
  identity = pathImpl.normalize(identity);
  if (resolvePlatform(options) === 'win32') identity = identity.toLowerCase();
  return crypto.createHmac('sha256', TOOL_TARGET_TOKEN_KEY).update(identity, 'utf8').digest('hex');
}

function readManagedToolConfig(toolId, options = {}) {
  const normalized = String(toolId || '').trim().toLowerCase();
  const resolvedOptions = configOptions(normalized, options);
  return {
    ...readManagedAppConfig(normalized, resolvedOptions),
    toolId: normalized,
    targetRevision: targetRevision(resolvedOptions.targetPath, resolvedOptions)
  };
}

function saveManagedToolConfig(toolId, content, options = {}) {
  const normalized = String(toolId || '').trim().toLowerCase();
  const resolvedOptions = configOptions(normalized, options);
  const currentTargetRevision = targetRevision(resolvedOptions.targetPath, resolvedOptions);
  if (!options.expectedTargetRevision || options.expectedTargetRevision !== currentTargetRevision) {
    throw new ToolkitConfigError(
      'config_target_changed',
      '配置目标在编辑期间发生变化，请重新读取后再保存'
    );
  }
  return {
    ...saveManagedAppConfig(normalized, content, resolvedOptions),
    toolId: normalized,
    targetRevision: currentTargetRevision
  };
}

module.exports = {
  TOOLKIT_TOOL_CATEGORIES,
  TOOL_DEFINITIONS,
  getToolDefinition,
  parseVersion,
  planManagedToolAction,
  resolveToolConfigPath,
  listManagedTools,
  readManagedToolConfig,
  saveManagedToolConfig
};
