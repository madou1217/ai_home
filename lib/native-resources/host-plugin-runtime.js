'use strict';
const { getHostResourceCapability } = require('./host-resource-registry');
const { createNativePluginManager } = require('./native-plugin-manager');
const { requireMcp } = require('./mcp-errors');
const path = require('node:path');

function buildManagedHostPluginArgs({ host, aiHomeDir, hostHomeDir } = {}) {
  const capability = getHostResourceCapability(host, 'plugin');
  if (!capability.launchArgument || !aiHomeDir || !hostHomeDir) return [];
  const manager = createNativePluginManager({ aiHomeDir, hostHomeDir });
  const report = manager.doctor({ host });
  requireMcp(report.healthy, 'native_plugin_runtime_projection_modified');
  return report.resources.filter(record => record.enabled).flatMap(record => {
    const target = capability.launchFromInstall ? record.nativeInstall?.launchPath : record.target;
    requireMcp(typeof target === 'string' && path.isAbsolute(target), 'native_plugin_runtime_projection_invalid');
    return [capability.launchArgument, target];
  });
}

module.exports = { buildManagedHostPluginArgs };
