'use strict';
const { spawnSync } = require('node:child_process');
const { listProviderDefinitions } = require('../provider-catalog');
const { defaultProviderResourceRegistry } = require('./provider-resource-registry');
const { RESOURCE_TYPES } = require('./resource-status');
const { probeHostRuntime, probeHostRuntimeAsync } = require('./host-runtime-discovery');
const { runProcess } = require('../../scripts/process-runner');
const { getHostResourceCapability } = require('./host-resource-registry');
const { resolveProviderResourceRuntime } = require('./provider-native-runtime');
const IMPORTED_HOSTS = Object.freeze([
  { host: 'deepseek', state: 'projection-only', harness: 'dsh', entry: 'lib/bin.js', cliExport: 'runCli', reason: 'native_owned_patch_boot_tool_cleanup_and_headless_loop_verified; Web/TUI entrypoints remain separate', evidence: 'scripts/deepseek-plugin-managed-demo.mjs' },
  { host: 'opencode', state: 'supported', reason: 'server_plugin_native_tool_loop_verified; TUI/RPC entrypoints remain separate', evidence: 'scripts/opencode-plugin-native-demo.js' },
  { host: 'pi', state: 'runtime-unavailable', harness: 'pi', entry: 'dist/bundle/cli.js', reason: 'native_directory_tool_command_cleanup_and_cli_tool_loop_verified; TUI/RPC entrypoints remain separate', evidence: 'scripts/pi-plugin-native-demo.js --managed' },
  { host: 'aih', state: 'supported', reason: 'canonical_signed_artifact_and_shared_core_supervised_host_verified', evidence: 'scripts/aih-portable-plugin-demo.js' }
]);
// Runtime probing is split into "resolve" (cheap, sync fs) and "observe" (spawning the
// CLI). The sync path keeps the CLI command behaviour; the async path lets the WebUI run
// every probe in parallel without blocking the event loop.
function runtimeIdentity(provider, options = {}) {
  const runtime = resolveProviderResourceRuntime(provider, options);
  if (!runtime) return { runtime: null, result: { available: false, reason: 'native_cli_not_registered' } };
  const identity = { binary: runtime.command, source: runtime.source, ...(runtime.args.length ? { args: runtime.args } : {}) };
  if (options.probeRuntime === false) return { runtime: null, result: { available: true, ...identity } };
  return { runtime, identity };
}
function runtimeProbeResult(identity, status, stdout, errorCode) {
  if (status === 0) return { available: true, ...identity, version: String(stdout || '').trim().split('\n')[0] };
  return { available: false, ...identity, reason: errorCode || 'native_cli_probe_failed' };
}
function runtimeProbe(provider, options = {}) {
  const { runtime, identity, result } = runtimeIdentity(provider, options);
  if (!runtime) return result;
  const probe = spawnSync(runtime.command, [...runtime.args, '--version'], { env: { ...process.env, ...runtime.env }, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  return runtimeProbeResult(identity, probe.status, probe.stdout, probe.error?.code);
}
async function runtimeProbeAsync(provider, options = {}) {
  const { runtime, identity, result } = runtimeIdentity(provider, options);
  if (!runtime) return result;
  const probe = await runProcess(runtime.command, [...runtime.args, '--version'], { env: { ...process.env, ...runtime.env }, timeoutMs: 5000, maxOutput: 65536, killGraceMs: 0 });
  return runtimeProbeResult(identity, probe.timedOut ? null : probe.status, probe.stdout, probe.timedOut ? 'ETIMEDOUT' : (probe.error || undefined));
}
function redactManaged(resources = []) { return resources.map(({ command, server, ...record }) => ({ ...record, ...(command ? { command: '[redacted]' } : {}), ...(server ? { argCount: server.args?.length || 0, envKeys: Object.keys(server.env || {}) } : {}) })); }
function createProviderResourceDoctor(options = {}) {
  const definitions = options.definitions || listProviderDefinitions(); const registry = options.registry || defaultProviderResourceRegistry;
  const providerRow = (definition, runtime) => ({ provider: definition.id, source: 'core/providers/native.go', runtime, resources: Object.fromEntries(RESOURCE_TYPES.map(resource => [resource, registry.get(definition.id, resource)])) });
  const hostRow = (row, runtime) => {
    const capability = getHostResourceCapability(row.host, 'plugin');
    return { ...row, ...(runtime.available && capability.state === 'supported' ? { state: 'supported' } : runtime.available && row.state === 'runtime-unavailable' ? { state: 'projection-only' } : {}), runtime };
  };
  const SOURCE = 'core/providers/native.go \u2192 contracts/providers/manifest.json';
  function capabilities() {
    return { source: SOURCE, providers: definitions.map(definition => providerRow(definition, runtimeProbe(definition.id, options))), hostAdapters: IMPORTED_HOSTS.map(row => (row.harness ? hostRow(row, probeHostRuntime(row, options)) : { ...row })) };
  }
  // Same report as capabilities(), with runtime probes spawned a few at a time (all at
  // once starves CPU-heavy node CLIs past the 5s probe timeout on a loaded host).
  async function capabilitiesAsync() {
    const limit = Math.max(1, Number(options.probeConcurrency) || 4);
    const jobs = [
      ...definitions.map(definition => async () => providerRow(definition, await runtimeProbeAsync(definition.id, options))),
      ...IMPORTED_HOSTS.map(row => async () => (row.harness ? hostRow(row, await probeHostRuntimeAsync(row, options)) : { ...row }))
    ];
    const results = new Array(jobs.length);
    let next = 0;
    const worker = async () => { while (next < jobs.length) { const index = next++; results[index] = await jobs[index](); } };
    await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
    return { source: SOURCE, providers: results.slice(0, definitions.length), hostAdapters: results.slice(definitions.length) };
  }
  function doctor() {
    const report = capabilities(); const managed = redactManaged(options.managed?.resources || []);
    return { ...report, managed, healthy: report.providers.every(row => RESOURCE_TYPES.every(resource => row.resources[resource].state !== 'unknown')) && report.hostAdapters.every(row => row.state !== 'unknown') };
  }
  return { capabilities, capabilitiesAsync, doctor };
}
module.exports = { createProviderResourceDoctor, IMPORTED_HOSTS };
