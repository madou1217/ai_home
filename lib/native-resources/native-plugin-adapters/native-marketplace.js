'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveProviderNativeRoot } = require('../../runtime/provider-storage-policy');
const { runNativeResourceCommand } = require('../provider-native-runtime');
const { stat, copyPackage, directoryStatus, removeOwned, atomicWrite } = require('../native-plugin-files');
const { requireMcp } = require('../mcp-errors');

const MARKETPLACE = 'aih-local';

function root(ctx) {
  return resolveProviderNativeRoot(ctx.hostHomeDir, ctx.provider);
}
function marketplaceRoot(ctx, id) {
  return path.join(ctx.aiHomeDir, 'managed-resources/native-plugin-marketplaces', ctx.provider, id);
}
function target(ctx, id, version) {
  return path.join(root(ctx), 'plugins/cache', MARKETPLACE, id, version || 'current');
}
function run(ctx, args) {
  return runNativeResourceCommand(ctx.provider, args, {
    hostHomeDir: ctx.hostHomeDir,
    runtime: ctx.runtime,
    cwd: ctx.hostHomeDir
  });
}
function list(ctx) {
  try {
    const rows = JSON.parse(run(ctx, ['plugin', 'list', '--json']));
    return Array.isArray(rows) ? rows : [];
  } catch (_) { return []; }
}
function knownMarketplace(ctx) {
  const file = path.join(root(ctx), 'plugins/known_marketplaces.json');
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const row = doc[MARKETPLACE];
    return row && typeof row === 'object' ? { file, row } : { file, row: null };
  } catch (_) { return { file, row: null }; }
}
function ensureMarketplace(ctx, pkg) {
  const market = marketplaceRoot(ctx, pkg.id);
  const pluginDir = path.join(market, 'plugins', pkg.id);
  if (stat(pluginDir)) requireMcp(directoryStatus({ target: pluginDir, digest: pkg.digest }) === 'present', 'native_plugin_marketplace_modified');
  else copyPackage(pkg, pluginDir);
  const manifest = {
    name: MARKETPLACE,
    owner: { name: 'AIH' },
    plugins: [{ name: pkg.id, source: `./plugins/${pkg.id}`, description: pkg.packageJson.description || '' }]
  };
  const manifestFile = path.join(market, '.claude-plugin/marketplace.json');
  if (stat(manifestFile)) {
    let current;
    try { current = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (_) { requireMcp(false, 'native_plugin_marketplace_modified'); }
    requireMcp(JSON.stringify(current) === JSON.stringify(manifest), 'native_plugin_marketplace_modified');
  } else atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const known = knownMarketplace(ctx);
  if (known.row) {
    const location = known.row.source?.path || known.row.installLocation;
    requireMcp(typeof location === 'string' && path.resolve(location) === path.resolve(market), 'native_plugin_marketplace_conflict');
  } else {
    run(ctx, ['plugin', 'marketplace', 'add', market]);
  }
  return { market, pluginDir };
}
function installed(ctx, id) {
  return list(ctx).find(row => row && (row.id === `${id}@${MARKETPLACE}` || row.pluginId === `${id}@${MARKETPLACE}`));
}
function install(ctx, pkg, record, previous) {
  const paths = ensureMarketplace(ctx, pkg);
  const current = installed(ctx, pkg.id);
  if (current) {
    requireMcp(previous, 'native_plugin_target_conflict');
    requireMcp(path.resolve(current.installPath || '') === path.resolve(record.target), 'native_plugin_install_path_mismatch');
    requireMcp(directoryStatus(record) === 'present', 'native_plugin_target_modified');
    return { status: 'installed', marketplace: MARKETPLACE, marketRoot: paths.market };
  }
  run(ctx, ['plugin', 'install', `${pkg.id}@${MARKETPLACE}`]);
  const after = installed(ctx, pkg.id);
  requireMcp(after && path.resolve(after.installPath || '') === path.resolve(record.target), 'native_plugin_install_path_mismatch');
  requireMcp(directoryStatus(record) === 'present', 'native_plugin_target_modified');
  return { status: 'installed', marketplace: MARKETPLACE, marketRoot: paths.market };
}
function disable(ctx, _pkg, record) {
  const current = installed(ctx, record.id);
  if (!current) return;
  requireMcp(directoryStatus(record) === 'present', 'native_plugin_target_modified');
  run(ctx, ['plugin', 'uninstall', `${record.id}@${MARKETPLACE}`, '--yes']);
  requireMcp(!installed(ctx, record.id), 'native_plugin_disable_failed');
}
function remove(ctx, pkg, record) {
  disable(ctx, pkg, record);
  const known = knownMarketplace(ctx);
  if (known.row) run(ctx, ['plugin', 'marketplace', 'remove', MARKETPLACE]);
  const market = marketplaceRoot(ctx, record.id);
  if (fs.existsSync(market)) fs.rmSync(market, { recursive: true, force: true });
  requireMcp(!fs.existsSync(market), 'native_plugin_marketplace_remove_failed');
}
function inspect(ctx, record) {
  const current = installed(ctx, record.id);
  if (!current) return stat(record.target) ? 'modified' : 'absent';
  if (path.resolve(current.installPath || '') !== path.resolve(record.target)) return 'modified';
  return directoryStatus(record);
}

module.exports = { target, install, disable, remove, inspect };
