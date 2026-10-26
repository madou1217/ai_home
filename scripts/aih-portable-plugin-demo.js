'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createPluginSystem } = require('../lib/plugins/control/plugin-system');
const { inspectArtifact } = require('../lib/plugins/control/artifact');
const { readPackage } = require('../lib/native-resources/native-plugin-files');
const { protocolVersion: transportProtocolVersion } = require('../lib/plugins/sdk/contract.generated.json');

const SOURCE = path.resolve(__dirname, '../examples/native-plugins/aih-demo');
const CONTRIBUTION = 'aih-demo.tool.aih_demo';

async function runAihPortablePluginDemo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-portable-host-'));
  const aiHomeDir = path.join(root, 'home');
  const env = { ...process.env, AIH_HOME_DIR: aiHomeDir };
  const cli = args => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/ai-home.js'), 'plugin', ...args, '--json'], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000
    });
    assert.equal(result.status, 0, result.error?.code || result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const sourceDigest = readPackage(SOURCE).digest;
  const steps = [];
  let system;
  try {
    const validation = cli(['validate', SOURCE, '--load']);
    assert.ok(validation.loaded.contributions.includes(CONTRIBUTION));
    steps.push({ stage: 'validate-load', passed: true });
    const keys = cli(['keygen', '--out', path.join(root, 'keys')]);
    cli(['trust', keys.publicKey, '--key-id', keys.keyId]);
    const artifact = path.join(root, 'canonical.aih-plugin');
    const packed = cli(['pack', SOURCE, artifact, '--signing-key', keys.privateKey, '--key-id', keys.keyId]);
    const inspected = inspectArtifact(artifact, { aiHomeDir, requireSigned: true });
    assert.equal(inspected.manifest.entry, 'dist/hosts/aih.mjs');
    assert.equal(inspected.manifest.protocolVersion, 1, 'legacy artifact manifest format');
    assert.equal(readPackage(SOURCE).packageJson.agentPlugin.hosts.aih.transportProtocolVersion, transportProtocolVersion, 'canonical transport matches the actual RPC contract');
    assert.equal(inspected.signature.status, 'signed');
    assert.equal(packed.signature.status, 'signed');
    assert.ok(inspected.files.some(file => file.path === 'plugin.json'));
    assert.equal(fs.existsSync(path.join(SOURCE, 'plugin.json')), false);
    assert.equal(readPackage(SOURCE).digest, sourceDigest, 'projection must not change canonical source');
    steps.push({ stage: 'signed-pack', generatedManifest: true, sourceUnchanged: true, legacyManifestProtocol: 1, transportProtocolVersion, passed: true });
    system = createPluginSystem({ aiHomeDir, providerDescriptorSync: false });
    const installed = system.control.install(artifact, { requireSigned: true });
    assert.equal(installed.signature.status, 'signed');
    await assert.rejects(async () => system.control.enable({ pluginId: 'aih-demo' }), { code: 'plugin_permissions_unacknowledged' });
    steps.push({ stage: 'install', signatureVerified: true, permissionGateVerified: true, passed: true });
    for (const stage of ['enabled', 'disabled', 're-enabled', 'restart', 'removed']) {
      const expected = stage === 'enabled' || stage === 're-enabled' || stage === 'restart';
      if (stage === 'enabled' || stage === 're-enabled') await system.control.enable({ pluginId: 'aih-demo', acceptPermissions: true });
      if (stage === 'disabled' || stage === 'removed') await system.control.disable({ instanceId: 'aih-demo', remove: stage === 'removed' });
      if (stage === 'restart') {
        await system.runtime.stop();
        system = createPluginSystem({ aiHomeDir, providerDescriptorSync: false });
        await system.runtime.start();
      }
      if (expected) {
        const result = await system.runtime.invoke(CONTRIBUTION, { text: 'portable-input' }, { timeoutMs: 2000 });
        assert.equal(result.value, 'AIH_PLUGIN_DEMO_OK:portable-input');
      } else await assert.rejects(() => system.runtime.invoke(CONTRIBUTION, { text: 'stale' }, { timeoutMs: 2000 }));
      if (stage === 'removed') system.control.uninstall({ pluginId: 'aih-demo' });
      steps.push({ stage, sharedCoreCalled: expected, unavailable: !expected, passed: true });
    }
    const doctor = system.control.doctor();
    assert.equal(doctor.ok, true);
    assert.equal(doctor.installed.length, 0);
    steps.push({ stage: 'doctor', installed: 0, passed: true });
    return { host: 'aih', package: 'aih-demo-plugin', runtime: 'supervised Cordis Host + RPC', node: process.versions.node, steps, passed: true };
  } finally {
    if (system) await system.runtime.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/aih-portable-plugin-demo.js');
  else runAihPortablePluginDemo().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
module.exports = { runAihPortablePluginDemo };
