'use strict';
const directory = require('./directory');
const { requireMcp } = require('../mcp-errors');
function validate(pkg) {
  let manifest;
  try { manifest = JSON.parse(pkg.files.find(file => file.name === 'gemini-extension.json')?.content.toString('utf8')); }
  catch (_) { requireMcp(false, 'native_plugin_manifest_invalid'); }
  requireMcp(manifest?.name === pkg.id && manifest?.version === pkg.version, 'native_plugin_manifest_mismatch');
}
module.exports = {
  ...directory,
  validate,
  install(ctx, pkg, record, previous) {
    validate(pkg);
    return directory.install(ctx, pkg, record, previous);
  },
  replace(ctx, pkg, record, previous) {
    validate(pkg);
    directory.disable(ctx, pkg, previous);
    return directory.install(ctx, pkg, record, null);
  }
};
