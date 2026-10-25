'use strict';

const RESOURCE_TYPES = Object.freeze(['plugin', 'skill', 'mcp']);
const STATES = new Set(['supported', 'partial', 'projection-only', 'unsupported']);

function list(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function status(state, reason, extra = {}) {
  const result = { state, reason: String(reason || '') };
  if (result.state === 'supported') delete result.reason;
  return Object.freeze({ ...result, ...extra });
}

function nativeResourceStatus(definition, resource) {
  const boundary = definition && definition.nativeBoundary;
  if (!boundary || !RESOURCE_TYPES.includes(resource)) {
    return status('unsupported', boundary ? 'resource_type_unknown' : 'native_boundary_missing');
  }
  if (resource === 'mcp') {
    const mcp = boundary.mcp;
    if (!mcp) return status('unsupported', 'mcp_boundary_missing');
    const commands = list(mcp.commands);
    const configFiles = list(mcp.configFiles);
    if (!commands.length && !configFiles.length) return status('unsupported', 'mcp_not_declared');
    return status('projection-only', 'mcp_manager_not_yet_installed', { commands, configFiles });
  }
  const source = resource === 'plugin' ? boundary.plugins : boundary.skills;
  if (!source) return status('unsupported', `${resource}_boundary_missing`);
  const commands = list(source.commands);
  const paths = list(source.paths);
  const mode = String(source.mode || '').trim();
  if (!commands.length && !paths.length) return status('unsupported', `${resource}_boundary_not_declared`);
  if (mode === 'native') return status('supported', '', { commands, paths, mode });
  return status('projection-only', `${resource}_projection_only`, { commands, paths, mode });
}

function buildNativeResourceMatrix(definitions) {
  return Object.fromEntries((Array.isArray(definitions) ? definitions : []).map((definition) => [
    String(definition.id || '').trim().toLowerCase(),
    Object.fromEntries(RESOURCE_TYPES.map((resource) => [resource, nativeResourceStatus(definition, resource)]))
  ]));
}

function validateNativeResourceMatrix(matrix) {
  for (const [provider, resources] of Object.entries(matrix || {})) {
    if (!provider) throw new Error('provider_resource_id_missing');
    for (const resource of RESOURCE_TYPES) {
      const item = resources && resources[resource];
      if (!item || !STATES.has(item.state)) throw new Error(`provider_resource_state_invalid:${provider}/${resource}`);
      if (item.state !== 'supported' && !item.reason) throw new Error(`provider_resource_reason_missing:${provider}/${resource}`);
    }
  }
  return true;
}

module.exports = { RESOURCE_TYPES, STATES, buildNativeResourceMatrix, nativeResourceStatus, validateNativeResourceMatrix };
