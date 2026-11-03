'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeRelativePath } = require('../sdk/manifest');
const { PluginError, requireCondition } = require('../sdk/errors');
const { protocolVersion: transportProtocolVersion } = require('../sdk/contract.generated.json');
const { properties: manifestProperties } = require('../sdk/manifest.schema.generated.json');

const PORTABLE_CAPABILITIES = new Set(['lifecycle', 'tool.register']);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { throw new PluginError('plugin_manifest_invalid', '插件清单不是合法 JSON'); }
}

function projectCanonicalManifest(pkg) {
  requireCondition(!pkg.files?.some(file => file.name === 'plugin.json'), 'plugin_manifest_source_conflict', 'canonical 包不能同时维护 plugin.json');
  const portable = pkg.packageJson.agentPlugin;
  requireCondition(portable?.manifestVersion === 1 && portable.portableApiVersion === 1, 'plugin_portable_api_incompatible');
  const host = portable.hosts?.aih;
  requireCondition(host?.hostAdapterApiVersion === 1 && host.transportProtocolVersion === transportProtocolVersion, 'plugin_adapter_incompatible');
  requireCondition(Object.keys(host).every(key => ['hostAdapterApiVersion', 'transportProtocolVersion', 'contributes'].includes(key)), 'plugin_adapter_projection_unsupported');
  requireCondition(Array.isArray(portable.capabilities), 'plugin_portable_capabilities_invalid');
  const declared = new Set();
  for (const capability of portable.capabilities) {
    requireCondition(capability && typeof capability.id === 'string' && Number.isInteger(capability.version)
      && typeof capability.required === 'boolean', 'plugin_portable_capabilities_invalid');
    requireCondition(!capability.required || (PORTABLE_CAPABILITIES.has(capability.id) && capability.version === 1), 'plugin_capability_incompatible');
    requireCondition(!declared.has(capability.id), 'plugin_capability_duplicate');
    declared.add(capability.id);
  }
  requireCondition([...PORTABLE_CAPABILITIES].every(id => portable.capabilities.some(item => item.id === id && item.version === 1)), 'plugin_capability_missing');
  const exported = pkg.packageJson.exports?.['./aih'];
  const entry = typeof exported === 'string' && exported.startsWith('./') ? exported.slice(2) : '';
  requireCondition(safeRelativePath(entry) && (!pkg.files || pkg.files.some(file => file.name === entry)), 'plugin_entry_missing');
  requireCondition(Array.isArray(host.contributes) && host.contributes.length > 0
    && host.contributes.every(item => item?.capability === 'command' && item.version === 1), 'plugin_adapter_projection_unsupported');
  const permissions = portable.permissions;
  requireCondition(permissions && Array.isArray(permissions.network) && Array.isArray(permissions.filesystem)
    && Array.isArray(permissions.secrets) && Object.keys(permissions).every(key => ['network', 'filesystem', 'secrets'].includes(key)), 'plugin_permissions_invalid');
  requireCondition(permissions.filesystem.every(scope => scope === 'private-state'), 'plugin_permission_filesystem_invalid');
  const stateScopes = permissions.filesystem.length ? ['state'] : [];
  return {
    manifestVersion: 1,
    // The legacy artifact manifest version is independent of the real RPC wire.
    protocolVersion: manifestProperties.protocolVersion.const,
    pluginId: portable.pluginId,
    version: pkg.version,
    engines: { aih: portable.engines?.aih, node: pkg.packageJson.engines?.node || '>=22' },
    runtime: 'node',
    entry,
    targets: ['any'],
    contributes: host.contributes,
    permissions: { network: permissions.network, filesystem: { read: stateScopes, write: stateScopes }, secrets: permissions.secrets }
  };
}

function readSourceManifest(dir) {
  const root = path.resolve(dir);
  const legacy = path.join(root, 'plugin.json');
  const packageFile = path.join(root, 'package.json');
  const packageJson = fs.existsSync(packageFile) ? readJson(packageFile) : null;
  if (packageJson?.agentPlugin) {
    requireCondition(!fs.existsSync(legacy), 'plugin_manifest_source_conflict', 'canonical 包不能同时维护 plugin.json');
    const manifest = projectCanonicalManifest({ packageJson, version: packageJson.version });
    let entry;
    try { entry = fs.lstatSync(path.join(root, manifest.entry)); } catch (_) {}
    requireCondition(entry?.isFile() && !entry.isSymbolicLink(), 'plugin_entry_missing');
    return { manifest, generated: true };
  }
  requireCondition(fs.existsSync(legacy), 'plugin_manifest_missing', `${dir} 下没有 plugin.json 或 canonical package.json`);
  return { manifest: readJson(legacy), generated: false };
}

module.exports = { projectCanonicalManifest, readSourceManifest };
