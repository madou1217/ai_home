'use strict';
const { spawnSync } = require('node:child_process');
const { listProviderDefinitions } = require('../provider-catalog');
const { defaultProviderResourceRegistry } = require('./provider-resource-registry');
const { RESOURCE_TYPES } = require('./resource-status');
const { probeHostRuntime } = require('./host-runtime-discovery');
const IMPORTED_HOSTS = Object.freeze([
  { host: 'deepseek', state: 'projection-only', harness: 'dsh', entry: 'lib/bin.js', cliExport: 'runCli', reason: 'native_profile_and_sdk_tool_lifecycle_verified; unified_aih_lifecycle_pending', evidence: 'scripts/deepseek-plugin-native-demo.mjs' },
  { host: 'opencode', state: 'supported', reason: 'server_plugin_local_projection_verified; TUI/RPC entrypoints remain separate', evidence: 'scripts/native-plugin-demo.js' },
  { host: 'pi', state: 'runtime-unavailable', harness: 'pi', entry: 'dist/bundle/cli.js', reason: 'native_tool_command_cleanup_verified; unified_aih_lifecycle_pending', evidence: 'scripts/pi-plugin-native-demo.js' },
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
    return { source: 'core/providers/native.go → contracts/providers/manifest.json', providers: definitions.map(definition => ({ provider: definition.id, source: 'core/providers/native.go', runtime: runtimeProbe(definition.id, options), resources: Object.fromEntries(RESOURCE_TYPES.map(resource => [resource, registry.get(definition.id, resource)])) })), hostAdapters: IMPORTED_HOSTS.map(row => {
      if (!row.harness) return { ...row };
      const runtime = probeHostRuntime(row, options);
      return { ...row, ...(runtime.available && row.state === 'runtime-unavailable' ? { state: 'projection-only' } : {}), runtime };
    }) };
  }
  function doctor() {
    const report = capabilities(); const managed = redactManaged(options.managed?.resources || []);
    return { ...report, managed, healthy: report.providers.every(row => RESOURCE_TYPES.every(resource => row.resources[resource].state !== 'unknown')) && report.hostAdapters.every(row => row.state !== 'unknown') };
  }
  return { capabilities, doctor };
}
module.exports = { createProviderResourceDoctor, IMPORTED_HOSTS };
