'use strict';

const { listManagedTools } = require('./tool-manager');
const { getToolPlugin, listToolPlugins } = require('./tool-plugins');
const { toNodePlatform, normalizeClientPlatform } = require('../../../runtime/client-platform');
const {
  controlToolService,
  createToolServiceConfig,
  describeToolService,
  readToolServiceLogs,
  restoreToolServices,
  updateToolServiceSettings
} = require('./service-control');
const { discoverNetworkTools } = require('./network-tool-discovery');

/**
 * 托管工具的服务控制门面：按 toolId 定位插件与当前探测结果，再交给 service-control 选择后端。
 */
function resolveServiceTarget(toolId, options = {}) {
  const normalized = String(toolId || '').trim().toLowerCase();
  const plugin = getToolPlugin(normalized);
  if (!plugin || !plugin.service) {
    return { error: { ok: false, error: 'service_unsupported', message: '该工具不提供服务管理。' } };
  }
  const networkRuntime = options.networkRuntime || discoverNetworkTools(options);
  const tool = listManagedTools({ ...options, networkRuntime, includeService: false }).tools
    .find((item) => item.id === normalized);
  if (!tool) {
    return { error: { ok: false, error: 'managed_tool_not_found', message: '工具不存在或不适用于当前系统。' } };
  }
  const runtime = networkRuntime[normalized] || {};
  return { plugin, tool: { ...tool, resolvedConfigPath: String(runtime.configPath || '') } };
}

function getManagedToolService(toolId, options = {}) {
  const target = resolveServiceTarget(toolId, options);
  if (target.error) return target.error;
  return { ok: true, toolId: target.tool.id, service: describeToolService(target.plugin, target.tool, options) };
}

async function controlManagedToolService(toolId, action, options = {}) {
  const target = resolveServiceTarget(toolId, options);
  if (target.error) return target.error;
  return { toolId: target.tool.id, ...(await controlToolService(target.plugin, target.tool, action, options)) };
}

function updateManagedToolServiceSettings(toolId, patch, options = {}) {
  const target = resolveServiceTarget(toolId, options);
  if (target.error) return target.error;
  return { toolId: target.tool.id, ...updateToolServiceSettings(target.plugin, target.tool, patch, options) };
}

function createManagedToolServiceConfig(toolId, options = {}) {
  const target = resolveServiceTarget(toolId, options);
  if (target.error) return target.error;
  return { toolId: target.tool.id, ...createToolServiceConfig(target.plugin, target.tool, options) };
}

function readManagedToolServiceLogs(toolId, options = {}) {
  const target = resolveServiceTarget(toolId, options);
  if (target.error) return target.error;
  return { toolId: target.tool.id, ...readToolServiceLogs(target.plugin, target.tool, options) };
}

/** AIH 服务端启动时接管/恢复由 AIH 守护的工具服务（只处理当前平台可用的插件）。 */
function restoreManagedToolServices(options = {}) {
  const processObj = options.processObj || process;
  const platform = toNodePlatform(normalizeClientPlatform(options.platform || processObj.platform));
  return restoreToolServices(listToolPlugins(platform), options);
}

module.exports = {
  controlManagedToolService,
  restoreManagedToolServices,
  createManagedToolServiceConfig,
  getManagedToolService,
  readManagedToolServiceLogs,
  updateManagedToolServiceSettings
};
