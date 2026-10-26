'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findRuntimePackage } = require('../lib/native-resources/host-runtime-discovery');
const { IMPORTED_HOSTS } = require('../lib/native-resources/provider-resource-doctor');
const { preparePiHarness } = require('../lib/harness/pi');

async function runPiPluginDemo(runtimePackage, { managed = false } = {}) {
  runtimePackage ||= findRuntimePackage(IMPORTED_HOSTS.find(host => host.host === 'pi'), { hostHomeDir: os.homedir() })?.packageDir;
  assert.ok(runtimePackage, 'Usage: node scripts/pi-plugin-native-demo.js <pi-package-directory>');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-pi-plugin-'));
  const home = path.join(root, 'home');
  const agentDir = path.join(home, '.pi/agent');
  const source = path.resolve(__dirname, '../examples/native-plugins/aih-demo');
  const cli = path.join(runtimePackage, 'dist/bundle/cli.js');
  const env = { ...process.env, HOME: home, USERPROFILE: home, AIH_HOME_DIR: path.join(root, 'aih'), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' };
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
      if (managed) {
        const command = { enabled: 'install', disabled: 'disable', 're-enabled': 'enable', removed: 'remove' }[stage];
        const bin = path.resolve(__dirname, '../bin/ai-home.js');
        const result = JSON.parse(run([bin, 'native', 'plugin', command, command === 'install' ? source : 'aih-demo', '--host', 'pi', '--json']));
        assert.equal(result.ok, true, 'AIH host plugin lifecycle');
        const listing = JSON.parse(run([bin, 'native', 'plugin', 'list', '--host', 'pi', '--json']));
        assert.equal(listing.resources.length, stage === 'removed' ? 0 : 1);
        if (listing.resources.length) {
          assert.equal(listing.resources[0].host, 'pi');
          assert.equal(listing.resources[0].provider, undefined, 'external host must not become an account provider');
        }
        assert.equal(JSON.parse(run([bin, 'native', 'plugin', 'doctor', '--host', 'pi', '--json'])).healthy, true);
      } else run([cli, action, source]);
      const result = JSON.parse(run([path.join(__dirname, 'portable-plugin-runtime-probe.mjs'), runtimePackage, agentDir, root, expected]));
      if (managed) {
        const prepared = await preparePiHarness({
          aiHomeDir: path.join(root, 'aih'), hostHomeDir: home,
          accountRef: 'acct_demo', provider: 'codex', model: 'demo',
          gateway: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-key' },
          catalog: { models: [{ id: 'demo' }] }
        });
        const extensions = prepared.args.flatMap((arg, index, args) => arg === '--extension' ? [args[index + 1]] : []);
        const accountResult = JSON.parse(run([path.join(__dirname, 'portable-plugin-runtime-probe.mjs'), runtimePackage, prepared.agentDir, root, expected, JSON.stringify(extensions)]));
        assert.equal(accountResult.discovered, result.discovered, 'isolated AIH harness uses the same managed plugins');
        result.accountHarnessVerified = true;
      }
      steps.push({ stage, ...result, passed: true });
    }
    return { host: 'pi', version, packageManager: managed ? 'AIH CLI host lifecycle + native Pi discovery' : 'native Pi install/remove', inference: 'none', steps, passed: true };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/pi-plugin-native-demo.js [installed-pi-package-directory] [--managed]');
  else runPiPluginDemo(process.argv.slice(2).find(arg => !arg.startsWith('--')), { managed: process.argv.includes('--managed') })
    .then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { runPiPluginDemo };
