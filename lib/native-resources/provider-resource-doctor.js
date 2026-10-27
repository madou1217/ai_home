'use strict';
const { spawnSync } = require('node:child_process');
const { listProviderDefinitions } = require('../provider-catalog');
const { defaultProviderResourceRegistry } = require('./provider-resource-registry');
const { RESOURCE_TYPES } = require('./resource-status');
const { probeHostRuntime } = require('./host-runtime-discovery');
const { getHostResourceCapability } = require('./host-resource-registry');
const { resolveProviderResourceRuntime } = require('./provider-native-runtime');
const IMPORTED_HOSTS = Object.freeze([
  { host: 'deepseek', state: 'projection-only', harness: 'dsh', entry: 'lib/bin.js', cliExport: 'runCli', reason: 'native_owned_patch_boot_tool_cleanup_and_headless_loop_verified; Web/TUI entrypoints remain separate', evidence: 'scripts/deepseek-plugin-managed-demo.mjs' },
  { host: 'opencode', state: 'supported', reason: 'server_plugin_native_tool_loop_verified; TUI/RPC entrypoints remain separate', evidence: 'scripts/opencode-plugin-native-demo.js' },
  { host: 'pi', state: 'runtime-unavailable', harness: 'pi', entry: 'dist/bundle/cli.js', reason: 'native_directory_tool_command_cleanup_and_cli_tool_loop_verified; TUI/RPC entrypoints remain separate', evidence: 'scripts/pi-plugin-native-demo.js --managed' },
  { host: 'aih', state: 'supported', reason: 'canonical_signed_artifact_and_shared_core_supervised_host_verified', evidence: 'scripts/aih-portable-plugin-demo.js' }
]);
function runtimeProbe(provider, options = {}) {
  const runtime = resolveProviderResourceRuntime(provider, options);
  if (!runtime) return { available: false, reason: 'native_cli_not_registered' };
  const identity = { binary: runtime.command, source: runtime.source, ...(runtime.args.length ? { args: runtime.args } : {}) };
  if (options.probeRuntime === false) return { available: true, ...identity };
  const result = spawnSync(runtime.command, [...runtime.args, '--version'], { env: { ...process.env, ...runtime.env }, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0) return { available: true, ...identity, version: String(result.stdout || '').trim().split('\n')[0] };
  return { available: false, ...identity, reason: result.error?.code || 'native_cli_probe_failed' };
}
function redactManaged(resources = []) { return resources.map(({ command, server, ...record }) => ({ ...record, ...(command ? { command: '[redacted]' } : {}), ...(server ? { argCount: server.args?.length || 0, envKeys: Object.keys(server.env || {}) } : {}) })); }
function createProviderResourceDoctor(options = {}) {
  const definitions = options.definitions || listProviderDefinitions(); const registry = options.registry || defaultProviderResourceRegistry;
  function capabilities() {
    return { source: 'core/providers/native.go → contracts/providers/manifest.json', providers: definitions.map(definition => ({ provider: definition.id, source: 'core/providers/native.go', runtime: runtimeProbe(definition.id, options), resources: Object.fromEntries(RESOURCE_TYPES.map(resource => [resource, registry.get(definition.id, resource)])) })), hostAdapters: IMPORTED_HOSTS.map(row => {
      if (!row.harness) return { ...row };
      const runtime = probeHostRuntime(row, options);
      const capability = getHostResourceCapability(row.host, 'plugin');
      return { ...row, ...(runtime.available && capability.state === 'supported' ? { state: 'supported' } : runtime.available && row.state === 'runtime-unavailable' ? { state: 'projection-only' } : {}), runtime };
    }) };
  }
  function doctor() {
    const report = capabilities(); const managed = redactManaged(options.managed?.resources || []);
    return { ...report, managed, healthy: report.providers.every(row => RESOURCE_TYPES.every(resource => row.resources[resource].state !== 'unknown')) && report.hostAdapters.every(row => row.state !== 'unknown') };
  }
  return { capabilities, doctor };
}
module.exports = { createProviderResourceDoctor, IMPORTED_HOSTS };
