'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveProviderNativeRoot } = require('../../runtime/provider-storage-policy');
const { stat, directoryStatus, copyPackage } = require('../native-plugin-files');
const { digestFiles } = require('../skill-package');
const { requireMcp } = require('../mcp-errors');

function nativeRoot(ctx) { return resolveProviderNativeRoot(ctx.hostHomeDir, ctx.provider); }
function name(ctx, id) {
  return `aih-${crypto.createHash('sha256').update(JSON.stringify([path.resolve(ctx.aiHomeDir), ctx.provider, id])).digest('hex').slice(0, 24)}`;
}
function safePath(base, target) {
  const relative = path.relative(base, target);
  requireMcp(!relative.startsWith('..') && !path.isAbsolute(relative), 'native_plugin_path_invalid');
  let current = base;
  for (const segment of ['', ...relative.split(path.sep)]) {
    current = path.join(current, segment);
    const info = stat(current);
    requireMcp(!info || !info.isSymbolicLink(), 'native_plugin_path_symlink');
  }
  return target;
}
function market(ctx, pkg) {
  const target = safePath(ctx.aiHomeDir, path.join(ctx.aiHomeDir, 'managed-resources/native-plugin-marketplaces', ctx.provider, pkg.id));
  const manifest = { name: name(ctx, pkg.id), owner: { name: 'AIH' }, plugins: [{ name: pkg.id, source: `./plugins/${pkg.id}`, description: pkg.packageJson.description || '' }] };
  const files = [
    { name: '.claude-plugin/marketplace.json', content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), executable: false },
    ...pkg.files.map(file => ({ ...file, name: `plugins/${pkg.id}/${file.name}` }))
  ];
  return { target, files, digest: digestFiles(files), name: manifest.name };
}
function readRegistry(ctx, relative) {
  const file = safePath(ctx.hostHomeDir, path.join(nativeRoot(ctx), relative));
  const info = stat(file);
  if (!info) return null;
  requireMcp(info.isFile() && info.size <= 1024 * 1024, 'native_plugin_registry_invalid');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { requireMcp(false, 'native_plugin_registry_invalid'); }
  requireMcp(doc && typeof doc === 'object' && !Array.isArray(doc), 'native_plugin_registry_invalid');
  return doc;
}
function validateNativeState(ctx) {
  const installed = readRegistry(ctx, 'plugins/installed_plugins.json');
  if (installed) {
    requireMcp(installed.version === 2 && installed.plugins && typeof installed.plugins === 'object' && !Array.isArray(installed.plugins), 'native_plugin_registry_invalid');
    for (const entries of Object.values(installed.plugins)) {
      requireMcp(Array.isArray(entries) && entries.every(row => row && ['user', 'project', 'local'].includes(row.scope) && typeof row.installPath === 'string' && path.isAbsolute(row.installPath) && typeof row.version === 'string'), 'native_plugin_registry_invalid');
    }
  }
  const settings = readRegistry(ctx, 'settings.json');
  if (settings && Object.hasOwn(settings, 'enabledPlugins')) {
    requireMcp(settings.enabledPlugins && typeof settings.enabledPlugins === 'object' && !Array.isArray(settings.enabledPlugins) && Object.values(settings.enabledPlugins).every(value => typeof value === 'boolean'), 'native_plugin_registry_invalid');
  }
  readRegistry(ctx, 'plugins/known_marketplaces.json');
}
function known(ctx, marketName) {
  const doc = readRegistry(ctx, 'plugins/known_marketplaces.json');
  if (!doc) return null;
  if (!Object.hasOwn(doc, marketName)) return null;
  const row = doc[marketName];
  requireMcp(row && typeof row === 'object' && !Array.isArray(row), 'native_plugin_registry_invalid');
  return row;
}
function verify(ctx, pkg, { allowMissing = false } = {}) {
  const owned = market(ctx, pkg);
  const row = known(ctx, owned.name);
  if (row) requireMcp(row.type === 'directory' && row.source?.source === 'directory' && typeof row.source.path === 'string' && typeof row.installLocation === 'string' && [row.source.path, row.installLocation].every(location => path.resolve(location) === path.resolve(owned.target)), 'native_plugin_marketplace_conflict');
  const status = directoryStatus(owned);
  requireMcp(status === 'present' || (allowMissing && status === 'absent' && !row), 'native_plugin_marketplace_modified');
  return { ...owned, row, status };
}
function ensure(ctx, pkg, run) {
  const owned = verify(ctx, pkg, { allowMissing: true });
  if (owned.status === 'absent') copyPackage(owned, owned.target);
  if (!owned.row) run(ctx, ['plugin', 'marketplace', 'add', owned.target]);
  requireMcp(verify(ctx, pkg).row, 'native_plugin_marketplace_registration_failed');
  return owned;
}

module.exports = { nativeRoot, name, safePath, verify, ensure, validateNativeState };
