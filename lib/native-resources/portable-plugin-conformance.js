'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readPackage, copyPackage } = require('./native-plugin-files');
const { requireMcp } = require('./mcp-errors');
const HOSTS = Object.freeze({
  deepseek: { exportKey: './deepseek', engine: 'deepseek' },
  opencode: { exportKey: './opencode/server', engine: 'opencode' },
  pi: { exportKey: './pi', engine: 'pi' },
  aih: { entryKey: 'core', engine: 'aih' }
});
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
    hosts[host] = { state, ...(entry ? { entry } : {}), ...(reason ? { reason } : {}) };
  }
  if (pkg.packageJson.pi?.extensions && !Array.isArray(pkg.packageJson.pi.extensions)) hosts.pi = { state: 'projection-invalid', reason: 'pi.extensions_not_array' };
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
