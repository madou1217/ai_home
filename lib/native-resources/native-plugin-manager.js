'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const jsonc = require('jsonc-parser');
const { createManagedResourceStore } = require('./managed-resource-store');
const { defaultProviderResourceRegistry } = require('./provider-resource-registry');
const { requireMcp } = require('./mcp-errors');
const { digestFiles, readSkillFiles } = require('./skill-package');
const { resolveProviderNativeRoot } = require('../runtime/provider-storage-policy');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function validateId(value) { if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value || '')) fail('native_plugin_id_invalid'); return value; }
function readPackage(source) {
  const root = path.resolve(source); const file = path.join(root, 'package.json');
  let packageJson; try { packageJson = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { fail('native_plugin_package_invalid'); }
  const id = String(packageJson.agentPlugin?.pluginId || packageJson.name || '').trim().toLowerCase(); validateId(id);
  requireMcp(packageJson.agentPlugin && packageJson.agentPlugin.manifestVersion === 1, 'native_plugin_manifest_invalid');
  const files = readSkillFiles(root); const digest = digestFiles(files); return { root, id, version: String(packageJson.version || ''), packageJson, files, digest };
}
function copyTree(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true }); const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try { fs.cpSync(source, temp, { recursive: true, errorOnExist: true }); fs.renameSync(temp, target); } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
function removeOwned(record) {
  if (!fs.existsSync(record.target)) return;
  if (record.digest && digestFiles(readSkillFiles(record.target)) !== record.digest) fail('native_plugin_target_modified');
  fs.rmSync(record.target, { recursive: true, force: true });
}
function providerCapability(registry, provider) {
  const item = registry.get(provider, 'plugin');
  if (item.state === 'unsupported') fail('native_plugin_provider_unsupported');
  return item;
}
function createNativePluginManager(options = {}) {
  const { aiHomeDir, hostHomeDir } = options; requireMcp(aiHomeDir && hostHomeDir, 'native_plugin_home_required');
  const registry = options.registry || defaultProviderResourceRegistry; const store = createManagedResourceStore({ aiHomeDir });
  const root = path.join(aiHomeDir, 'managed-resources', 'native-plugins');
  const binary = provider => options.nativeBinaries?.[provider] || provider;
  function capability(provider) {
    const item = registry.get(provider, 'plugin'); return { provider, ...item, runtime: Boolean(options.nativeBinaries?.[provider] || false) };
  }
  function target(provider, id) {
    const cap = providerCapability(registry, provider); const nativeRoot = resolveProviderNativeRoot(hostHomeDir, provider);
    if (provider === 'claude') return { mode: cap.state === 'supported' ? 'native' : 'projection-only', target: path.join(nativeRoot, 'skills', id) };
    if (provider === 'opencode') return { mode: 'native', target: path.join(hostHomeDir, '.config', 'opencode', 'plugins', id) };
    if (provider === 'codex') return { mode: 'native', target: path.join(hostHomeDir, '.codex', 'plugins', 'cache', 'aih-local', id) };
    const relative = Array.isArray(cap.paths) && cap.paths.length ? cap.paths[0] : '';
    if (nativeRoot && relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..')) return { mode: 'native', target: path.join(nativeRoot, relative, id) };
    fail('native_plugin_adapter_missing');
  }
  function snapshot(pkg) {
    const target = path.join(root, pkg.id, pkg.version); if (!fs.existsSync(target)) copyTree(pkg.root, target); return target;
  }
  function find(state, id, provider) { return state.resources.find(x => x.kind === 'native-plugin' && x.id === id && x.provider === provider); }
  function codexInstall(pkg, snapshotDir) {
    const marketplaceRoot = path.join(snapshotDir, 'marketplace'); const marketplace = path.join(marketplaceRoot, '.agents', 'plugins'); fs.mkdirSync(marketplace, { recursive: true });
    const manifest = { name: 'aih-local', owner: { name: 'AIH' }, plugins: [{ name: pkg.id, source: `./plugins/${pkg.id}`, description: pkg.packageJson.description || '' }] };
    const pluginDir = path.join(marketplaceRoot, 'plugins', pkg.id); if (!fs.existsSync(pluginDir)) copyTree(pkg.root, pluginDir); fs.writeFileSync(path.join(marketplace, 'marketplace.json'), JSON.stringify(manifest, null, 2));
    fs.mkdirSync(path.join(hostHomeDir, '.codex'), { recursive: true });
    const env = { ...process.env, HOME: hostHomeDir, USERPROFILE: hostHomeDir, CODEX_HOME: path.join(hostHomeDir, '.codex') };
    const add = spawnSync(binary('codex'), ['plugin', 'marketplace', 'add', marketplaceRoot, '--json'], { env, encoding: 'utf8', timeout: 30000 });
    requireMcp(add.status === 0, 'native_plugin_marketplace_add_failed');
    const install = spawnSync(binary('codex'), ['plugin', 'add', `${pkg.id}@aih-local`, '--json'], { env, encoding: 'utf8', timeout: 30000 });
    requireMcp(install.status === 0, 'native_plugin_install_failed');
    return { status: 'installed', marketplace: 'aih-local', nativeOutput: JSON.parse(install.stdout || '{}') };
  }
  function projectOpenCode(pkg, record, remove = false) {
    if (remove) {
      const config = path.join(hostHomeDir, '.config/opencode/opencode.json'); let text = '{}'; try { text = fs.readFileSync(config, 'utf8'); } catch (_) {}
      const existing = jsonc.parse(text || '{}'); const list = Array.isArray(existing.plugin) ? existing.plugin.filter(item => item !== record.target) : [];
      if (fs.existsSync(config)) fs.writeFileSync(config, jsonc.applyEdits(text || '{}', jsonc.modify(text || '{}', ['plugin'], list, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } })));
      removeOwned(record); return;
    }
    if (!fs.existsSync(record.target)) copyTree(pkg.root, record.target); const config = path.join(hostHomeDir, '.config/opencode/opencode.json'); fs.mkdirSync(path.dirname(config), { recursive: true });
    let text = '{}'; try { text = fs.readFileSync(config, 'utf8'); } catch (_) {}
    const existing = jsonc.parse(text || '{}'); const list = Array.isArray(existing.plugin) ? existing.plugin.slice() : []; if (!list.includes(record.target)) list.push(record.target);
    fs.writeFileSync(config, jsonc.applyEdits(text || '{}', jsonc.modify(text || '{}', ['plugin'], list, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } })));
  }
  function install(source, { provider } = {}) {
    const pkg = readPackage(source); providerCapability(registry, provider); const state = store.get(); const previous = find(state, pkg.id, provider); const snapshotDir = snapshot(pkg); const projection = target(provider, pkg.id);
    if (previous && previous.digest !== pkg.digest) removeOwned(previous);
    const record = { kind: 'native-plugin', id: pkg.id, provider, version: pkg.version, digest: pkg.digest, target: projection.target, mode: projection.mode, enabled: true, createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now() };
    let nativeInstall = { status: 'projected' };
    if (provider === 'codex') nativeInstall = codexInstall(pkg, snapshotDir);
    else if (provider === 'opencode') projectOpenCode(pkg, record);
    else if (!fs.existsSync(record.target)) copyTree(pkg.root, record.target);
    return store.update(current => { const existing = find(current, pkg.id, provider); if (existing) Object.assign(existing, record, { nativeInstall }); else current.resources.push({ ...record, nativeInstall }); return { ...record, pluginId: record.id, nativeInstall }; });
  }
  function change(id, { provider } = {}, action) {
    return store.update(state => { const record = find(state, id, provider); if (!record) fail('native_plugin_not_installed');
      if (action === 'enable') { const pkg = readPackage(path.join(root, id, record.version)); if (provider === 'codex') { const nativeInstall = codexInstall(pkg, path.join(root, id, record.version)); record.nativeInstall = nativeInstall; } else { if (fs.existsSync(record.target)) { if (digestFiles(readSkillFiles(record.target)) !== record.digest) fail('native_plugin_target_modified'); } else copyTree(pkg.root, record.target); } record.enabled = true; }
      else { if (provider === 'opencode') { projectOpenCode(readPackage(path.join(root, id, record.version)), record, true); } else if (provider === 'codex' && action !== 'remove') { const env={...process.env,HOME:hostHomeDir,USERPROFILE:hostHomeDir,CODEX_HOME:path.join(hostHomeDir,'.codex')}; spawnSync(binary('codex'),['plugin','remove',`${id}@aih-local`,'--json'],{env,encoding:'utf8',timeout:30000}); } else if (provider !== 'opencode') removeOwned(record); record.enabled = false; }
      if (action === 'remove') state.resources.splice(state.resources.indexOf(record), 1); else if (record.enabled !== (action === 'enable')) { record.enabled = action === 'enable'; record.updatedAt = Date.now(); } return { ...record, removed: action === 'remove' };
    });
  }
  function list({ provider } = {}) { const state = store.get(); return { revision: state.revision, resources: state.resources.filter(x => x.kind === 'native-plugin' && (!provider || x.provider === provider)).map(({ digest, ...x }) => ({ ...x, digest: digest.slice(0, 12) })) }; }
  function doctor({ provider } = {}) { const state = store.get(); const resources = state.resources.filter(x => x.kind === 'native-plugin' && (!provider || x.provider === provider)).map(record => ({ ...record, healthy: record.enabled ? fs.existsSync(record.target) || record.provider === 'codex' : !fs.existsSync(record.target) })); return { revision: state.revision, healthy: resources.every(x => x.healthy), resources }; }
  return { capability, target: (id, selection) => target(selection.provider, id), install, list, doctor, enable: (id, s) => change(id, s, 'enable'), disable: (id, s) => change(id, s, 'disable'), remove: (id, s) => change(id, s, 'remove') };
}
module.exports = { createNativePluginManager, readPackage };
