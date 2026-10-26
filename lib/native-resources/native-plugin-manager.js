'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createManagedResourceStore } = require('./managed-resource-store');
const { defaultProviderResourceRegistry } = require('./provider-resource-registry');
const { requireMcp } = require('./mcp-errors');
const { ADAPTERS } = require('./native-plugin-adapters');
const { readPackage, snapshotPackage, verifySnapshot, removeOwned } = require('./native-plugin-files');
function createNativePluginManager(options = {}) {
  const { aiHomeDir, hostHomeDir } = options;
  requireMcp(aiHomeDir && hostHomeDir, 'native_plugin_home_required');
  const registry = options.registry || defaultProviderResourceRegistry;
  const store = createManagedResourceStore({ aiHomeDir }); const root = path.join(aiHomeDir, 'managed-resources', 'native-plugins');
  function resolve(provider) {
    const capability = registry.get(provider, 'plugin');
    requireMcp(capability.state !== 'unsupported', 'native_plugin_provider_unsupported');
    const adapter = ADAPTERS[capability.adapter];
    requireMcp(adapter, 'native_plugin_adapter_missing');
    return { adapter, context: { provider, capability, aiHomeDir, hostHomeDir, binary: options.nativeBinaries?.[provider] || provider } };
  }
  function find(state, id, provider) { return state.resources.find(x => x.kind === 'native-plugin' && x.id === id && x.provider === provider); }
  function install(source, { provider } = {}) {
    const pkg = readPackage(source); const { adapter, context } = resolve(provider); const snapshotDir = snapshotPackage(root, pkg);
    return store.update(state => {
      const previous = find(state, pkg.id, provider);
      if (previous && previous.digest !== pkg.digest) adapter.disable(context, pkg, previous);
      const record = { kind: 'native-plugin', id: pkg.id, provider, version: pkg.version, digest: pkg.digest, target: adapter.target(context, pkg.id, pkg.version), mode: 'native', enabled: true, createdAt: previous?.createdAt || Date.now(), updatedAt: previous?.updatedAt || Date.now() };
      record.nativeInstall = adapter.install(context, pkg, record, previous, snapshotDir);
      if (previous) Object.assign(previous, record); else state.resources.push(record);
      return { ...record, pluginId: record.id };
    });
  }
  function change(id, { provider } = {}, action) {
    const { adapter, context } = resolve(provider);
    return store.update(state => {
      const record = find(state, id, provider); requireMcp(record, 'native_plugin_not_installed');
      const snapshotDir = path.join(root, id, record.version); const pkg = verifySnapshot(snapshotDir, record); const enabled = action === 'enable';
      if (enabled) record.nativeInstall = adapter.install(context, pkg, record, record, snapshotDir);
      else if (record.enabled || adapter.inspect(context, record) !== 'absent') adapter.disable(context, pkg, record);
      if (action === 'remove') state.resources.splice(state.resources.indexOf(record), 1);
      else if (record.enabled !== enabled) { record.enabled = enabled; record.updatedAt = Date.now(); }
      return { ...record, enabled, removed: action === 'remove' };
    });
  }
  function list({ provider } = {}) { const state = store.get(); return { revision: state.revision, resources: state.resources.filter(x => x.kind === 'native-plugin' && (!provider || x.provider === provider)) }; }
  function doctor({ provider } = {}) {
    const state = store.get(); const resources = state.resources.filter(x => x.kind === 'native-plugin' && (!provider || x.provider === provider)).map(record => {
      const { adapter, context } = resolve(record.provider); return { ...record, healthy: record.enabled ? adapter.inspect(context, record) === 'present' : adapter.inspect(context, record) === 'absent' };
    }); return { revision: state.revision, healthy: resources.every(x => x.healthy), resources };
  }
  return { install, list, doctor, capability: provider => ({ provider, ...registry.get(provider, 'plugin'), runtime: Boolean(options.nativeBinaries?.[provider]) }), target: (id, selection) => { const { adapter, context } = resolve(selection.provider); return { mode: 'native', target: adapter.target(context, id, '') }; }, enable: (id, s) => change(id, s, 'enable'), disable: (id, s) => change(id, s, 'disable'), remove: (id, s) => change(id, s, 'remove') };
}
module.exports = { createNativePluginManager, readPackage };
