'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runPiPluginDemo(runtimePackage) {
  assert.ok(runtimePackage, 'Usage: node scripts/pi-plugin-native-demo.js <pi-package-directory>');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-pi-plugin-'));
  const home = path.join(root, 'home');
  const agentDir = path.join(home, '.pi/agent');
  const source = path.resolve(__dirname, '../examples/native-plugins/aih-demo');
  const cli = path.join(runtimePackage, 'dist/bundle/cli.js');
  const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' };
  const run = args => {
    const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.error?.code || result.stderr || result.stdout);
    return result.stdout;
  };
  const steps = [];
  try {
    fs.mkdirSync(home, { recursive: true });
    const version = run([cli, '--version']).trim();
    for (const [stage, action, expected] of [
      ['enabled', 'install', 'enabled'], ['disabled', 'remove', 'disabled'],
      ['re-enabled', 'install', 'enabled'], ['removed', 'remove', 'disabled']
    ]) {
      run([cli, action, source]);
      const result = JSON.parse(run([path.join(__dirname, 'portable-plugin-runtime-probe.mjs'), runtimePackage, agentDir, root, expected]));
      steps.push({ stage, ...result, passed: true });
    }
    return { host: 'pi', version, packageManager: 'native Pi install/remove', inference: 'none', steps, passed: true };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) {
  try { console.log(JSON.stringify(runPiPluginDemo(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { runPiPluginDemo };
