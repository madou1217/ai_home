'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const providerManifest = require('../contracts/providers/manifest.json');

const RESOURCE_TYPES = ['plugin', 'skill', 'mcp'];
const VALID_STATES = new Set(['supported', 'partial', 'projection-only', 'unsupported']);

function currentNativeResourceStatus(definition, resource) {
  const boundary = definition && definition.nativeBoundary;
  if (!boundary) return { state: 'unsupported', reason: 'native_boundary_missing' };
  if (resource === 'mcp') {
    const mcp = boundary.mcp;
    if (!mcp) return { state: 'unsupported', reason: 'mcp_boundary_missing' };
    const commands = Array.isArray(mcp.commands) ? mcp.commands : [];
    const configFiles = Array.isArray(mcp.configFiles) ? mcp.configFiles : [];
    if (!commands.length && !configFiles.length) return { state: 'unsupported', reason: 'mcp_not_declared' };
    return { state: 'projection-only', reason: 'mcp_manager_not_yet_installed' };
  }
  if (resource === 'plugin') {
    const hooks = boundary.hooks;
    if (!hooks) return { state: 'unsupported', reason: 'plugin_boundary_missing' };
    const files = Array.isArray(hooks.files) ? hooks.files : [];
    return files.length
      ? { state: 'projection-only', reason: 'native_plugin_manager_not_yet_installed' }
      : { state: 'unsupported', reason: 'native_plugin_boundary_not_declared' };
  }
  const config = boundary.config;
  if (!config) return { state: 'unsupported', reason: 'skill_boundary_missing' };
  const paths = [
    ...(Array.isArray(config.userSettings) ? config.userSettings : []),
    ...(Array.isArray(config.projectSettings) ? config.projectSettings : [])
  ];
  return paths.length
    ? { state: 'projection-only', reason: 'skill_manager_not_yet_installed' }
    : { state: 'unsupported', reason: 'skill_boundary_not_declared' };
}

test('every provider has an explicit baseline resource result', () => {
  assert.ok(Array.isArray(providerManifest.providers));
  assert.ok(providerManifest.providers.length > 0);
  for (const definition of providerManifest.providers) {
    assert.ok(definition.id, 'provider id is required');
    for (const resource of RESOURCE_TYPES) {
      const result = currentNativeResourceStatus(definition, resource);
      assert.ok(VALID_STATES.has(result.state), `${definition.id}/${resource} has invalid state`);
      if (result.state !== 'supported') assert.ok(result.reason, `${definition.id}/${resource} needs a reason`);
    }
  }
});

test('baseline matrix does not silently claim native support', () => {
  const rows = providerManifest.providers.flatMap((definition) => RESOURCE_TYPES.map((resource) => ({
    provider: definition.id,
    resource,
    ...currentNativeResourceStatus(definition, resource)
  })));
  assert.ok(rows.some((row) => row.state === 'projection-only'));
  assert.ok(rows.some((row) => row.state === 'unsupported'));
  assert.ok(rows.every((row) => row.state !== 'supported'));
});
