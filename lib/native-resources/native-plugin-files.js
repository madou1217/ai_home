'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');
const { digestFiles, readSkillFiles, writeFiles } = require('./skill-package');
const { requireMcp } = require('./mcp-errors');
function stat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function readPackage(source) {
  const root = path.resolve(source);
  const files = readSkillFiles(root);
  let packageJson;
  try { packageJson = JSON.parse(files.find(x => x.name === 'package.json')?.content.toString('utf8')); }
  catch (_) { requireMcp(false, 'native_plugin_package_invalid'); }
  const id = packageJson.agentPlugin?.pluginId;
  requireMcp(typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id), 'native_plugin_id_invalid');
  requireMcp(packageJson.agentPlugin?.manifestVersion === 1, 'native_plugin_manifest_invalid');
  requireMcp(typeof packageJson.version === 'string' && semver.valid(packageJson.version) === packageJson.version, 'native_plugin_version_invalid');
  return { root, id, version: packageJson.version, packageJson, files, digest: digestFiles(files) };
}
function copyPackage(pkg, target) {
  requireMcp(!stat(target), 'native_plugin_target_conflict');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try { writeFiles(temporary, pkg.files); fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function directoryStatus(record) {
  const info = stat(record.target);
  if (!info) return 'absent';
  if (!info.isDirectory() || info.isSymbolicLink()) return 'modified';
  try { return digestFiles(readSkillFiles(record.target)) === record.digest ? 'present' : 'modified'; }
  catch (_) { return 'modified'; }
}
function removeOwned(record) {
  const status = directoryStatus(record);
  requireMcp(status !== 'modified', 'native_plugin_target_modified');
  if (status === 'present') fs.rmSync(record.target, { recursive: true });
}
function ensureOwned(pkg, record, previous) {
  const status = directoryStatus(record);
  if (status !== 'absent') {
    requireMcp(previous, 'native_plugin_target_conflict');
    requireMcp(directoryStatus(previous) === 'present', 'native_plugin_target_modified');
    requireMcp(previous.digest === record.digest, 'native_plugin_version_conflict');
    return;
  }
  copyPackage(pkg, record.target);
}
function snapshotPackage(root, pkg) {
  const target = path.join(root, pkg.id, pkg.version);
  if (stat(target)) requireMcp(readPackage(target).digest === pkg.digest, 'native_plugin_version_conflict');
  else copyPackage(pkg, target);
  return target;
}
function verifySnapshot(target, record) {
  let pkg;
  try { pkg = readPackage(target); } catch (_) { requireMcp(false, 'native_plugin_snapshot_modified'); }
  requireMcp(pkg.digest === record.digest && pkg.id === record.id && pkg.version === record.version, 'native_plugin_snapshot_modified');
  return pkg;
}
function atomicWrite(file, text) {
  const info = stat(file);
  requireMcp(!info || (info.isFile() && !info.isSymbolicLink()), 'native_plugin_config_conflict');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, text, { flag: 'wx', mode: info ? info.mode & 0o777 : 0o600 }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
module.exports = { stat, readPackage, copyPackage, directoryStatus, removeOwned, ensureOwned, snapshotPackage, verifySnapshot, atomicWrite };
