'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const yaml = require('yaml');
const { requireMcp } = require('./mcp-errors');

function packageFile(pkg, relative) {
  return typeof relative === 'string' && relative.startsWith('./') && !relative.split(/[\\/]/).includes('..')
    ? pkg.files.find(file => file.name === relative.slice(2)) : undefined;
}
function readCordisPatchEntry(pkg, exportKey) {
  const patch = packageFile(pkg, pkg.packageJson.dsh?.bundle?.patch);
  requireMcp(patch, 'native_plugin_patch_missing');
  let document;
  let rows;
  try {
    document = yaml.parseDocument(patch.content.toString('utf8'));
    requireMcp(!document.errors.length, 'native_plugin_patch_invalid');
    requireMcp(!document.warnings.length, 'native_plugin_patch_unsupported');
    rows = document.toJS({ maxAliasCount: 10 });
  } catch (error) {
    requireMcp(false, error.code || 'native_plugin_patch_invalid');
  }
  // The portable subset owns one configured native entry. Multi-entry bundles,
  // grouping, profile overrides and conditions stay with native DSH management.
  requireMcp(Array.isArray(rows) && rows.length === 1 && rows[0] && Object.keys(rows[0]).length === 1 && Array.isArray(rows[0].insert) && rows[0].insert.length === 1, 'native_plugin_patch_unsupported');
  const entry = rows[0].insert[0];
  requireMcp(entry && typeof entry === 'object' && !Array.isArray(entry) && entry.name === `${pkg.packageJson.name}${exportKey.slice(1)}`, 'native_plugin_patch_unsupported');
  requireMcp(Object.keys(entry).every(key => ['id', 'name', 'config', 'disabled'].includes(key)), 'native_plugin_patch_unsupported');
  requireMcp(entry.disabled === undefined || entry.disabled === false, 'native_plugin_patch_unsupported');
  const file = pkg.packageJson.exports?.[exportKey];
  requireMcp(packageFile(pkg, file), 'native_plugin_host_projection_invalid');
  return { entry, file };
}
function projectCordisPatch(pkg, target, exportKey) {
  const { entry, file } = readCordisPatchEntry(pkg, exportKey);
  return yaml.stringify([{ insert: [{ ...entry, name: pathToFileURL(path.join(target, file)).href }] }]);
}
module.exports = { readCordisPatchEntry, projectCordisPatch };
