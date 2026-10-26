'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { defaultProviderResourceRegistry } = require('./provider-resource-registry');
const { resolveProviderNativeRoot } = require('../runtime/provider-storage-policy');
const { createManagedResourceStore } = require('./managed-resource-store');
const { fail, validateSkillId, readSkillPackage, writeFiles } = require('./skill-package');
const { SKILL_PROJECTIONS } = require('./skill-projections');

function createSkillManager(options = {}) {
  const { aiHomeDir, hostHomeDir } = options;
  if (!aiHomeDir || !hostHomeDir) fail('skill_home_required');
  const registry = options.registry || defaultProviderResourceRegistry;
  const store = createManagedResourceStore({ aiHomeDir });
  const packageRoot = path.join(aiHomeDir, 'managed-resources', 'skills');
  const matches = (record, filter) => record.kind === 'skill' && (!filter.provider || record.provider === filter.provider);
  function target(id, { provider } = {}) {
    validateSkillId(id);
    const capability = registry.get(provider, 'skill');
    const adapter = SKILL_PROJECTIONS[capability.mode];
    const relative = capability.paths?.[0];
    const root = capability.pathBase === 'host-home' ? hostHomeDir : resolveProviderNativeRoot(hostHomeDir, provider);
    if (!adapter || !relative || !root) fail('skill_provider_unsupported');
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) fail('skill_path_invalid');
    return { provider, scope: 'host', mode: capability.mode, target: path.join(root, relative, ...(capability.mode === 'native' ? [id] : [])) };
  }
  function snapshot(pkg) {
    const dir = path.join(packageRoot, pkg.digest);
    if (fs.existsSync(dir)) {
      if (readSkillPackage(dir).digest !== pkg.digest) fail('skill_snapshot_modified');
      return;
    }
    fs.mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
    const temp = `${dir}.${crypto.randomUUID()}.tmp`;
    try { writeFiles(temp, pkg.files); fs.renameSync(temp, dir); }
    finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  function packageFor(record) {
    if (!/^[a-f0-9]{64}$/.test(record.digest)) fail('skill_digest_invalid');
    const pkg = readSkillPackage(path.join(packageRoot, record.digest));
    if (pkg.digest !== record.digest || pkg.id !== record.id) fail('skill_snapshot_modified');
    return pkg;
  }
  function find(state, id, provider) {
    return state.resources.find((record) => record.kind === 'skill' && record.id === id && record.provider === provider && record.scope === 'host');
  }
  function install(source, selection = {}) {
    const pkg = readSkillPackage(path.resolve(source));
    const projection = target(pkg.id, selection);
    return store.update((state) => {
      const previous = find(state, pkg.id, selection.provider);
      if (selection.onlyIfDefault && previous && (!previous.enabled || previous.removed)) return { ...previous };
      snapshot(pkg);
      const record = { kind: 'skill', id: pkg.id, ...projection, digest: pkg.digest, enabled: true, removed: false };
      const adapter = SKILL_PROJECTIONS[record.mode];
      adapter.apply(record, pkg, previous, previous && packageFor(previous));
      if (previous && Object.entries(record).every(([key, value]) => previous[key] === value)) return { ...previous };
      record.createdAt = previous?.createdAt || Date.now();
      record.updatedAt = Date.now();
      if (previous) Object.assign(previous, record);
      else state.resources.push(record);
      return { ...record };
    });
  }
  function change(id, selection = {}, action) {
    target(id, selection);
    return store.update((state) => {
      const record = find(state, id, selection.provider);
      if (!record || (record.removed && action !== 'remove')) fail('skill_not_installed');
      const pkg = packageFor(record);
      const adapter = SKILL_PROJECTIONS[record.mode];
      if (action === 'enable') adapter.apply(record, pkg, record, pkg);
      else adapter.remove(record, pkg);
      const enabled = action === 'enable';
      const removed = action === 'remove';
      if (record.enabled !== enabled || record.removed !== removed) {
        Object.assign(record, { enabled, removed, updatedAt: Date.now() });
      }
      return { ...record };
    });
  }
  function list(filter = {}) {
    const state = store.get();
    return { revision: state.revision, resources: state.resources.filter((record) => matches(record, filter) && !record.removed) };
  }
  function doctor(filter = {}) {
    const state = store.get();
    const resources = state.resources.filter((record) => matches(record, filter)).map((record) => {
      try {
        const pkg = packageFor(record);
        const projection = SKILL_PROJECTIONS[record.mode].inspect(record, pkg);
        return { ...record, projection, healthy: record.enabled ? projection === 'present' : projection === 'absent' };
      } catch (error) { return { ...record, healthy: false, error: error.code || 'skill_snapshot_unavailable' }; }
    });
    const providers = (filter.provider ? [filter.provider] : registry.listProviders()).map((provider) => ({ provider, ...registry.get(provider, 'skill') }));
    return { healthy: resources.every((record) => record.healthy), revision: state.revision, resources, providers };
  }
  return {
    target, install, list, doctor,
    enable: (id, selection) => change(id, selection, 'enable'),
    disable: (id, selection) => change(id, selection, 'disable'),
    remove: (id, selection) => change(id, selection, 'remove'),
    reconcileBuiltin: (source, selection) => install(source, { ...selection, onlyIfDefault: true })
  };
}
module.exports = { createSkillManager };
