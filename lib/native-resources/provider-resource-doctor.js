'use strict';
const { spawnSync } = require('node:child_process');
const { listProviderDefinitions } = require('../provider-catalog');
const { defaultProviderResourceRegistry } = require('./provider-resource-registry');
const { RESOURCE_TYPES } = require('./resource-status');
const IMPORTED_HOSTS = Object.freeze([
  { host: 'deepseek', state: 'projection-only', reason: 'canonical_deepseek_entry_verified; harness_runtime_adapter_not_registered', evidence: 'aih native plugin inspect/project + spec:2026-10-25-universal-agent-plugin-design §4.1' },
  { host: 'opencode', state: 'supported', reason: 'server_plugin_local_projection_verified; TUI/RPC entrypoints remain separate', evidence: 'scripts/native-plugin-demo.js' },
  { host: 'pi', state: 'runtime-unavailable', reason: 'pi_binary_not_found_on_this_machine; package_projection_only', evidence: 'examples/native-plugins/aih-demo/package.json' },
  { host: 'aih', state: 'supported', reason: 'signed_artifact_and_supervised_host', evidence: 'scripts/plugin-closure-demo.js' }
]);
function runtimeProbe(provider, options = {}) {
  const binary = options.nativeBinaries?.[provider];
  if (!binary) return { available: false, reason: 'native_cli_not_registered' };
  if (options.probeRuntime === false) return { available: true, binary };
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0) return { available: true, binary, version: String(result.stdout || '').trim().split('\n')[0] };
  return { available: false, binary, reason: result.error?.code || 'native_cli_probe_failed' };
}
function redactManaged(resources = []) { return resources.map(({ command, server, ...record }) => ({ ...record, ...(command ? { command: '[redacted]' } : {}), ...(server ? { argCount: server.args?.length || 0, envKeys: Object.keys(server.env || {}) } : {}) })); }
function createProviderResourceDoctor(options = {}) {
  const definitions = options.definitions || listProviderDefinitions(); const registry = options.registry || defaultProviderResourceRegistry;
  function capabilities() {
    return { source: 'core/providers/native.go → contracts/providers/manifest.json', providers: definitions.map(definition => ({ provider: definition.id, source: 'core/providers/native.go', runtime: runtimeProbe(definition.id, options), resources: Object.fromEntries(RESOURCE_TYPES.map(resource => [resource, registry.get(definition.id, resource)])) })), hostAdapters: IMPORTED_HOSTS.map(x => ({ ...x })) };
  }
  function doctor() {
    const report = capabilities(); const managed = redactManaged(options.managed?.resources || []);
    return { ...report, managed, healthy: report.providers.every(row => RESOURCE_TYPES.every(resource => row.resources[resource].state !== 'unknown')) && report.hostAdapters.every(row => row.state !== 'unknown') };
  }
  return { capabilities, doctor };
}
module.exports = { createProviderResourceDoctor, IMPORTED_HOSTS };
