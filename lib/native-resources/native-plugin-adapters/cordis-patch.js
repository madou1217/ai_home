'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = require('./directory');
const { projectCordisPatch } = require('../cordis-patch-projection');
const { requireMcp } = require('../mcp-errors');
const { stat, atomicWrite, ensureOwned, removeOwned, directoryStatus } = require('../native-plugin-files');

const digest = text => crypto.createHash('sha256').update(text).digest('hex');
function patchPath(ctx, id) {
  return path.join(ctx.aiHomeDir, 'managed-resources/native-plugin-patches', ctx.host, `${id}.yml`);
}
function patchStatus(record) {
  const file = record.nativeInstall?.launchPath;
  if (!file || !stat(file)) return 'absent';
  const info = stat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) return 'modified';
  return digest(fs.readFileSync(file)) === record.nativeInstall.patchDigest ? 'present' : 'modified';
}

module.exports = {
  target: directory.target,
  install(ctx, pkg, record, previous) {
    const file = patchPath(ctx, pkg.id);
    if (stat(file)) {
      requireMcp(previous?.nativeInstall?.launchPath === file, 'native_plugin_target_conflict');
      requireMcp(patchStatus(previous) === 'present', 'native_plugin_target_modified');
    }
    const entry = pkg.packageJson.exports?.[ctx.capability.entryExport];
    const text = projectCordisPatch(pkg, record.target, ctx.capability.entryExport);
    ensureOwned(pkg, record, previous);
    atomicWrite(file, text);
    return { status: 'projected', launchPath: file, patchDigest: digest(text), entry };
  },
  disable(_ctx, _pkg, record) {
    const projected = directoryStatus(record);
    const patch = patchStatus(record);
    requireMcp(projected !== 'modified' && patch !== 'modified', 'native_plugin_target_modified');
    if (patch === 'present') fs.unlinkSync(record.nativeInstall.launchPath);
    removeOwned(record);
  },
  inspect(_ctx, record) {
    const projected = directoryStatus(record);
    const patch = patchStatus(record);
    return projected === patch ? projected : 'modified';
  }
};
