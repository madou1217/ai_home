'use strict';

const {
  readProcessEntries,
  readStartupEntries,
  tokenizeCommandLine
} = require('./host-runtime-discovery');
const {
  FRP_CONFIG_EXTENSIONS,
  FRP_ROLES,
  discoverNetworkTools,
  extractConfigPath,
  resolveNetworkToolConfigPath
} = require('./network-tool-discovery');

function discoverFrpTools(options = {}) {
  const discovered = discoverNetworkTools(options);
  return {
    frpc: discovered.frpc
  };
}

function resolveFrpConfigPath(toolId, options = {}) {
  const normalized = String(toolId || '').trim().toLowerCase();
  return FRP_ROLES.includes(normalized)
    ? resolveNetworkToolConfigPath(normalized, options)
    : '';
}

module.exports = {
  FRP_CONFIG_EXTENSIONS,
  FRP_ROLES,
  discoverFrpTools,
  extractConfigPath,
  readProcessEntries,
  readStartupEntries,
  resolveFrpConfigPath,
  tokenizeCommandLine
};
