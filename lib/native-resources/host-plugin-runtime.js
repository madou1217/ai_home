'use strict';
const { getHostResourceCapability } = require('./host-resource-registry');
const { createNativePluginManager } = require('./native-plugin-manager');
const { requireMcp } = require('./mcp-errors');

function buildManagedHostPluginArgs({ host, aiHomeDir, hostHomeDir } = {}) {
  const capability = getHostResourceCapability(host, 'plugin');
  if (!capability.launchArgument || !aiHomeDir || !hostHomeDir) return [];
  const manager = createNativePluginManager({ aiHomeDir, hostHomeDir });
  const report = manager.doctor({ host });
  requireMcp(report.healthy, 'native_plugin_runtime_projection_modified');
  return report.resources.filter(record => record.enabled).flatMap(record => [capability.launchArgument, record.target]);
}

module.exports = { buildManagedHostPluginArgs };
