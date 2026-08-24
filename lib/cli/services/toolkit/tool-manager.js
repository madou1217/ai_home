'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const {
  normalizeClientPlatform
} = require('../../../runtime/client-platform');
const {
  ToolkitConfigError,
  readManagedAppConfig,
  saveManagedAppConfig
} = require('./config-editor');
const {
  getManagedToolAdapter,
  listManagedToolAdapters
} = require('./managed-tools');
const {
  parseVersion,
  resolvePathApi,
  resolvePlatform
} = require('./managed-tools/shared');

const TOOL_TARGET_TOKEN_KEY = crypto.randomBytes(32);
const MANAGED_TOOL_ACTIONS = new Set(['install', 'update', 'uninstall']);

const TOOLKIT_TOOL_CATEGORIES = Object.freeze([
  Object.freeze({
    id: 'session-runtimes',
    label: '会话运行时',
    description: '管理 AIH 使用的终端复用器和持久会话后端。'
  }),
  Object.freeze({
    id: 'network-access',
    label: '网络接入与隧道',
    description: '管理 AIH 使用的网络接入与反向隧道客户端。'
  })
]);

const TOOL_DEFINITIONS = Object.freeze(listManagedToolAdapters().map((adapter) => Object.freeze({
  id: adapter.id,
  category: adapter.category,
  name: adapter.name,
  role: adapter.role,
  binaryName: adapter.binaryName,
  versionArgs: adapter.versionArgs,
  capabilities: adapter.capabilities,
  runtimeInspectable: adapter.runtimeInspectable
})));

function getToolDefinition(toolId) {
  const adapter = getManagedToolAdapter(toolId);
  if (!adapter) throw new ToolkitConfigError('unsupported_tool', `不支持管理工具 ${toolId || 'unknown'}`);
  return adapter;
}

function buildManagedTool(adapter, options = {}) {
  const detected = adapter.detect(options) || {};
  const installed = Boolean(detected.installed);
  const canInstall = Boolean(detected.canInstall);
  const canUpdate = Boolean(detected.canUpdate);
  const canUninstall = Boolean(detected.canUninstall);
  return {
    id: adapter.id,
    category: adapter.category,
    name: adapter.name,
    role: adapter.role,
    binaryName: String(detected.binaryName || adapter.binaryName),
    capabilities: adapter.capabilities,
    runtimeInspectable: adapter.runtimeInspectable,
    ...detected,
    installed,
    canInstall,
    canUpdate,
    canUninstall,
    lifecycle: { install: canInstall, update: canUpdate, uninstall: canUninstall }
  };
}

function listManagedTools(options = {}) {
  const platform = resolvePlatform(options);
  const tools = listManagedToolAdapters()
    .filter((adapter) => adapter.supports(options))
    .map((adapter) => buildManagedTool(adapter, options));
  return {
    ok: true,
    platform: normalizeClientPlatform(platform),
    categories: TOOLKIT_TOOL_CATEGORIES,
    total: tools.length,
    installedCount: tools.filter((tool) => tool.installed).length,
    tools
  };
}

function normalizeAction(value) {
  const action = String(value || '').trim().toLowerCase();
  return MANAGED_TOOL_ACTIONS.has(action) ? action : '';
}

function lifecycleUnavailable(tool, action) {
  if (action === 'install' && tool.installed) {
    return { ok: false, error: 'managed_tool_already_installed', message: `${tool.name} 已安装。` };
  }
  if (action !== 'install' && !tool.installed) {
    return { ok: false, error: 'managed_tool_not_installed', message: `${tool.name} 尚未安装。` };
  }
  return {
    ok: false,
    error: 'managed_tool_lifecycle_contract_violation',
    message: '工具状态与生命周期计划不一致，请重新探测后重试。'
  };
}

function planManagedToolAction(input = {}, options = {}) {
  const toolId = String(input.toolId || '').trim().toLowerCase();
  const action = normalizeAction(input.action);
  const adapter = getManagedToolAdapter(toolId);
  if (!adapter) return { ok: false, error: 'managed_tool_not_found', message: '工具不存在。' };
  if (!action) {
    return { ok: false, error: 'unsupported_managed_tool_action', message: '仅支持安装、更新和卸载。' };
  }
  if (!adapter.supports(options)) {
    return { ok: false, error: 'unsupported_platform', message: `${adapter.name} 不支持当前系统。` };
  }
  const tool = buildManagedTool(adapter, options);
  const planned = adapter[action]({ tool, options });
  if (planned && !Array.isArray(planned) && planned.ok === false) return planned;
  if (!tool.lifecycle[action]) return lifecycleUnavailable(tool, action);
  const plans = Array.isArray(planned) ? planned : planned && planned.plans || [];
  if (!plans.length) return lifecycleUnavailable(tool, action);
  return {
    ok: true,
    platform: normalizeClientPlatform(resolvePlatform(options)),
    tool: { id: tool.id, name: tool.name, category: tool.category },
    action,
    label: `${action === 'install' ? '安装' : action === 'update' ? '更新' : '卸载'} ${tool.name}`,
    plans,
    current: tool
  };
}

function resolveConfigDescriptor(toolId, options = {}) {
  const adapter = getToolDefinition(toolId);
  if (!adapter.supports(options)) {
    throw new ToolkitConfigError('unsupported_platform', `${adapter.name} 不支持当前系统`);
  }
  if (typeof adapter.resolveConfig !== 'function') {
    throw new ToolkitConfigError('tool_config_unsupported', `${adapter.name} 没有可直接编辑的本地配置文件`);
  }
  const descriptor = adapter.resolveConfig(options) || {};
  if (descriptor.state === 'unresolved') {
    throw new ToolkitConfigError(
      'config_target_unresolved',
      `${adapter.name} 运行或启动参数指向的配置当前无法安全读取`
    );
  }
  if (descriptor.ambiguous) {
    throw new ToolkitConfigError(
      'config_target_ambiguous',
      `发现多个 ${adapter.name} 配置文件，无法在隐藏路径的前提下安全确定编辑目标`
    );
  }
  if (!String(descriptor.targetPath || '').trim()) {
    throw new ToolkitConfigError('config_target_unavailable', '当前平台没有可解析的配置目标');
  }
  return { adapter, ...descriptor, targetPath: String(descriptor.targetPath).trim() };
}

function resolveToolConfigPath(toolId, options = {}) {
  try {
    return resolveConfigDescriptor(toolId, options).targetPath;
  } catch (_error) {
    return '';
  }
}

function configOptions(toolId, options = {}) {
  const descriptor = resolveConfigDescriptor(toolId, options);
  return {
    ...options,
    targetPath: descriptor.targetPath,
    allowMissingTarget: Boolean(descriptor.allowMissing)
  };
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
