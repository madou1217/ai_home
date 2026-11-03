'use strict';

const path = require('node:path');
const { runNativeResourceCommand } = require('../provider-native-runtime');
const { stat, directoryStatus, removeOwned, verifySnapshot } = require('../native-plugin-files');
const { requireMcp } = require('../mcp-errors');
const { readSkillFiles, digestFiles } = require('../skill-package');
const ownership = require('./marketplace-ownership');

function target(ctx, id, version) {
  return ownership.safePath(ctx.hostHomeDir, path.join(ownership.nativeRoot(ctx), 'plugins/cache', ownership.name(ctx, id), id, version || 'current'));
}
function run(ctx, args) {
  ownership.validateNativeState(ctx);
  return runNativeResourceCommand(ctx.provider, args, { hostHomeDir: ctx.hostHomeDir, runtime: ctx.runtime, cwd: ctx.hostHomeDir });
}
function installed(ctx, id) {
  const output = run(ctx, ['plugin', 'list', '--json']);
  let rows;
  try { rows = JSON.parse(output); } catch (_) { requireMcp(false, 'native_plugin_response_invalid'); }
  requireMcp(Array.isArray(rows) && rows.every(row => row && typeof row.id === 'string' && typeof row.installPath === 'string' && typeof row.enabled === 'boolean'), 'native_plugin_response_invalid');
  const matches = rows.filter(row => row.id === `${id}@${ownership.name(ctx, id)}`);
  requireMcp(matches.length <= 1 && matches.every(row => row.scope === 'user'), 'native_plugin_scope_conflict');
  return matches[0];
}
function legacy(ctx, record) {
  return record.nativeInstall?.status === 'projected' && path.resolve(record.target) === path.join(ownership.nativeRoot(ctx), 'plugins', record.id);
}
function validatePackage(pkg) {
  let manifest;
  try { manifest = JSON.parse(pkg.files.find(file => file.name === '.claude-plugin/plugin.json')?.content.toString('utf8')); }
  catch (_) { requireMcp(false, 'native_plugin_manifest_invalid'); }
  requireMcp(manifest?.name === pkg.id && manifest?.version === pkg.version, 'native_plugin_manifest_mismatch');
}
function checkTarget(ctx, record, current) {
  requireMcp(path.resolve(record.target) === target(ctx, record.id, record.version), 'native_plugin_legacy_projection_migration_required');
  if (current) requireMcp(path.resolve(current.installPath) === path.resolve(record.target), 'native_plugin_install_path_mismatch');
  requireMcp(directoryStatus(record) !== 'modified', 'native_plugin_target_modified');
  if (current) requireMcp(directoryStatus(record) === 'present', 'native_plugin_target_modified');
}
function install(ctx, pkg, record, previous) {
  validatePackage(pkg);
  requireMcp(path.resolve(record.target) === target(ctx, record.id, record.version), 'native_plugin_legacy_projection_migration_required');
  const oldDirectory = previous && legacy(ctx, previous);
  if (oldDirectory) {
    ownership.safePath(ctx.hostHomeDir, previous.target);
    requireMcp(directoryStatus(previous) !== 'modified', 'native_plugin_target_modified');
  } else if (previous) checkTarget(ctx, previous);
  const current = installed(ctx, pkg.id);
  requireMcp((!current && !stat(record.target)) || (previous && !oldDirectory), 'native_plugin_target_conflict');
  checkTarget(ctx, record, current);
  const owned = ownership.ensure(ctx, pkg, run);
  const reference = `${pkg.id}@${owned.name}`;
  if (!current) run(ctx, ['plugin', 'install', reference, '--scope', 'user']);
  else if (!current.enabled) run(ctx, ['plugin', 'enable', reference, '--scope', 'user']);
  const after = installed(ctx, pkg.id);
  checkTarget(ctx, record, after);
  requireMcp(after?.enabled === true, 'native_plugin_enable_failed');
  if (oldDirectory) removeOwned(previous);
  return { status: 'installed', marketplace: owned.name, marketRoot: owned.target };
}
function disable(ctx, pkg, record) {
  if (legacy(ctx, record)) { ownership.safePath(ctx.hostHomeDir, record.target); removeOwned(record); return; }
  ownership.verify(ctx, pkg);
  const current = installed(ctx, record.id);
  checkTarget(ctx, record, current);
  if (current?.enabled) run(ctx, ['plugin', 'disable', `${record.id}@${ownership.name(ctx, record.id)}`, '--scope', 'user']);
  requireMcp(!installed(ctx, record.id)?.enabled, 'native_plugin_disable_failed');
}
function removableCache(record) {
  if (directoryStatus(record) !== 'modified') return record;
  // Native uninstall retains its cache and adds this timestamp, even with
  // --keep-data. Accept only that observed metadata; all package bytes still match.
  const files = readSkillFiles(record.target);
  const marker = files.find(file => file.name === '.orphaned_at');
  requireMcp(marker && !marker.executable && /^\d{13}$/.test(marker.content.toString()) && digestFiles(files.filter(file => file !== marker)) === record.digest, 'native_plugin_target_modified');
  return { ...record, digest: digestFiles(files) };
}
function remove(ctx, pkg, record) {
  if (legacy(ctx, record)) { ownership.safePath(ctx.hostHomeDir, record.target); removeOwned(record); return; }
  const owned = ownership.verify(ctx, pkg, { allowMissing: true });
  const current = installed(ctx, record.id);
  checkTarget(ctx, current ? record : removableCache(record), current);
  if (current) run(ctx, ['plugin', 'uninstall', `${record.id}@${owned.name}`, '--scope', 'user', '--yes', '--keep-data']);
  requireMcp(!installed(ctx, record.id), 'native_plugin_remove_failed');
  if (owned.row) run(ctx, ['plugin', 'marketplace', 'remove', owned.name]);
  requireMcp(!ownership.verify(ctx, pkg, { allowMissing: true }).row, 'native_plugin_marketplace_remove_failed');
  removeOwned(removableCache(record));
  removeOwned(owned);
}
function inspect(ctx, record) {
  if (legacy(ctx, record)) return stat(record.target) ? 'legacy' : 'absent';
  const pkg = verifySnapshot(path.join(ctx.aiHomeDir, 'managed-resources/native-plugins', record.id, record.version), record);
  ownership.verify(ctx, pkg);
  const current = installed(ctx, record.id);
  checkTarget(ctx, record, current);
  if (!current) return stat(record.target) ? 'modified' : 'absent';
  return current.enabled ? 'present' : 'absent';
}

function replace(ctx, pkg, record, previous) {
  validatePackage(pkg);
  const oldPackage = verifySnapshot(path.join(ctx.aiHomeDir, 'managed-resources/native-plugins', previous.id, previous.version), previous);
  requireMcp(record.target === target(ctx, record.id, record.version) && !stat(record.target), 'native_plugin_target_conflict');
  remove(ctx, oldPackage, previous);
  try { return install(ctx, pkg, record, null); }
  catch (error) {
    // SQLite retains the previous desired record on failure. Restore that same
    // native state when the partial replacement is still demonstrably owned.
    try {
      remove(ctx, pkg, record);
      install(ctx, oldPackage, previous, null);
      if (!previous.enabled) disable(ctx, oldPackage, previous);
    } catch (recoveryError) { error.recoveryCode = recoveryError.code || 'native_plugin_recovery_failed'; }
    throw error;
  }
}

module.exports = { target, install, disable, remove, inspect, replace };
