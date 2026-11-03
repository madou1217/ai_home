'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readCordisPatchEntry } = require('./cordis-patch-projection');
const { readPackage, copyPackage } = require('./native-plugin-files');
const { requireMcp } = require('./mcp-errors');
const { projectCanonicalManifest } = require('../plugins/control/source-manifest');
const { validateManifest } = require('../plugins/sdk/manifest');
const HOSTS = Object.freeze({
  deepseek: { exportKey: './deepseek', engine: 'deepseek', validate: validateDeepSeek },
  opencode: { exportKey: './opencode/server', engine: 'opencode', validate: validateOpenCode },
  pi: { exportKey: './pi', engine: 'pi', validate: validatePi },
  aih: { exportKey: './aih', engine: 'aih', validate: validateAih }
});
function validateAih(pkg) {
  try { validateManifest(projectCanonicalManifest(pkg)); }
  catch (error) { return error.code || 'aih.manifest_projection_invalid'; }
}
function packageFile(pkg, entry) {
  return typeof entry === 'string' && entry.startsWith('./') && !entry.split(/[\\/]/).includes('..')
    ? pkg.files.find(file => file.name === entry.slice(2)) : undefined;
}
function validatePi(pkg, entry) {
  const entries = pkg.packageJson.pi?.extensions;
  if (!Array.isArray(entries) || !entries.includes(entry) || entries.some(item => !packageFile(pkg, item))) return 'pi.extensions_entry_mismatch';
}
function validateOpenCode(pkg, entry) {
  const nativeEntry = pkg.packageJson.exports?.['./server'] || pkg.packageJson.main;
  if (nativeEntry !== entry) return 'opencode.server_entry_mismatch';
}
function validateDeepSeek(pkg) {
  try { readCordisPatchEntry(pkg, './deepseek'); }
  catch (error) { return error.code || 'dsh.bundle.patch_invalid'; }
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { requireMcp(false, 'portable_plugin_package_invalid'); } }
function inspectPortablePlugin(source) {
  const pkg = readPackage(source); const hosts = {};
  for (const [host, spec] of Object.entries(HOSTS)) {
    const entry = spec.entryKey ? pkg.packageJson.agentPlugin?.[spec.entryKey] : pkg.packageJson.exports?.[spec.exportKey];
    const engine = pkg.packageJson.agentPlugin?.engines?.[spec.engine];
    let state = 'projection-ready'; let reason = '';
    if (!engine) { state = 'engine-missing'; reason = `agentPlugin.engines.${spec.engine}`; }
    else if (typeof entry !== 'string' || !entry.startsWith('./') || entry.includes('..')) { state = 'projection-missing'; reason = spec.entryKey ? `agentPlugin.${spec.entryKey}` : `exports.${spec.exportKey}`; }
    else if (!fs.existsSync(path.join(pkg.root, entry))) { state = 'projection-missing'; reason = `entry_file_missing:${entry}`; }
    if (state === 'projection-ready' && spec.validate) {
      const mismatch = spec.validate(pkg, entry);
      if (mismatch) { state = 'projection-invalid'; reason = mismatch; }
    }
    hosts[host] = { state, ...(entry ? { entry } : {}), ...(reason ? { reason } : {}) };
  }
  return { pluginId: pkg.id, version: pkg.version, digest: pkg.digest, hosts };
}
function projectPortablePlugin(source, host, outputDir) {
  const report = inspectPortablePlugin(source); const item = report.hosts[host];
  requireMcp(item, 'portable_plugin_host_unknown'); requireMcp(item.state === 'projection-ready', 'portable_plugin_projection_unavailable');
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const pkg = readPackage(source); const temporary = `${outputDir}.${crypto.randomUUID()}.tmp`;
  try {
    copyPackage(pkg, temporary);
    fs.writeFileSync(path.join(temporary, 'host-projection.json'), JSON.stringify({ host, pluginId: report.pluginId, entry: item.entry, state: item.state }, null, 2));
    fs.renameSync(temporary, outputDir);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return { host, pluginId: report.pluginId, entry: item.entry, state: item.state, outputDir };
}
module.exports = { HOSTS, inspectPortablePlugin, projectPortablePlugin };
