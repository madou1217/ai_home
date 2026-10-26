'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { requireMcp } = require('../mcp-errors');
const { stat, copyPackage, directoryStatus, atomicWrite } = require('../native-plugin-files');
const marketplaceName = _id => 'aih-local';
function run(ctx, args) {
  const result = spawnSync(ctx.binary, args, {
    env: { ...process.env, HOME: ctx.hostHomeDir, USERPROFILE: ctx.hostHomeDir, CODEX_HOME: path.join(ctx.hostHomeDir, '.codex') },
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024
  });
  requireMcp(result.status === 0, 'native_plugin_command_failed');
  try { return JSON.parse(result.stdout); } catch (_) { requireMcp(false, 'native_plugin_response_invalid'); }
}
function listInstalled(ctx, id) {
  return (run(ctx, ['plugin', 'list', '--json']).installed || []).find(x => x.pluginId === `${id}@${marketplaceName(id)}`);
}
module.exports = {
  target: (ctx, id, version) => path.join(ctx.hostHomeDir, '.codex/plugins/cache', marketplaceName(id), id, version || 'current'),
  install(ctx, pkg, record, previous) {
    fs.mkdirSync(path.join(ctx.hostHomeDir, '.codex'), { recursive: true });
    const name = marketplaceName(pkg.id);
    const marketRoot = path.join(ctx.aiHomeDir, 'managed-resources/native-plugin-marketplaces', pkg.id);
    const installed = listInstalled(ctx, pkg.id);
    requireMcp(!installed || previous, 'native_plugin_target_conflict');
    requireMcp(!stat(record.target) || previous, 'native_plugin_target_conflict');
    const markets = run(ctx, ['plugin', 'marketplace', 'list', '--json']).marketplaces || [];
    const existing = markets.find(x => x.name === name || x.marketplaceName === name);
    if (existing) {
      const source = existing.source || existing.sourcePath || existing.path || existing.root || existing.installedRoot;
      const location = typeof source === 'string' ? source : source?.source || source?.path;
      requireMcp(location && path.resolve(location) === path.resolve(fs.realpathSync(marketRoot)), 'native_plugin_marketplace_conflict');
    }
    const pluginDir = path.join(marketRoot, 'plugins', pkg.id);
    if (!stat(pluginDir)) copyPackage(pkg, pluginDir);
    else requireMcp(directoryStatus({ target: pluginDir, digest: pkg.digest }) === 'present', 'native_plugin_snapshot_modified');
    atomicWrite(path.join(marketRoot, '.agents/plugins/marketplace.json'), JSON.stringify({ name, owner: { name: 'AIH' }, plugins: [{ name: pkg.id, source: `./plugins/${pkg.id}`, description: pkg.packageJson.description || '' }] }, null, 2));
    if (!existing) run(ctx, ['plugin', 'marketplace', 'add', marketRoot, '--json']);
    if (installed) {
      requireMcp(directoryStatus(record) === 'present', 'native_plugin_target_modified');
      return previous.nativeInstall;
    }
    const output = run(ctx, ['plugin', 'add', `${pkg.id}@${name}`, '--json']);
    requireMcp(typeof output.installedPath === 'string' && path.resolve(output.installedPath) === path.resolve(fs.realpathSync(record.target)), 'native_plugin_install_path_mismatch');
    requireMcp(directoryStatus(record) === 'present', 'native_plugin_target_modified');
    return { status: 'installed', marketplace: name };
  },
  disable(ctx, _pkg, record) {
    const installed = listInstalled(ctx, record.id);
    if (installed) {
      requireMcp(directoryStatus(record) === 'present', 'native_plugin_target_modified');
      run(ctx, ['plugin', 'remove', `${record.id}@${marketplaceName(record.id)}`, '--json']);
    }
  },
  remove(ctx, _pkg, record) {
    this.disable(ctx, _pkg, record);
    const name = marketplaceName(record.id);
    const markets = run(ctx, ['plugin', 'marketplace', 'list', '--json']).marketplaces || [];
    if (markets.some(x => x.name === name || x.marketplaceName === name)) run(ctx, ['plugin', 'marketplace', 'remove', name, '--json']);
  },
  inspect(ctx, record) {
    const installed = listInstalled(ctx, record.id);
    if (!installed) return stat(record.target) ? 'modified' : 'absent';
    return directoryStatus(record);
  }
};
