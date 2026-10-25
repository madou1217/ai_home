'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildArtifact } = require('../lib/plugins/control/artifact');
const { createPluginSystem } = require('../lib/plugins/control/plugin-system');

const ECHO_DIR = path.join(__dirname, '..', 'examples', 'plugins', 'echo');

function temporaryHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-plugin-closure-'));
}

async function stopSystem(system) {
  try { await system.runtime.stop(); } catch (_error) {}
}

test('AIH plugin lifecycle closes install, enable, use, restart, disable and uninstall', async () => {
  const aiHomeDir = temporaryHome();
  const artifactFile = path.join(aiHomeDir, 'echo.aih-plugin');
  let system = null;
  let recovered = null;
  try {
    const built = buildArtifact(ECHO_DIR, artifactFile, { hostVersion: '1.0.0' });
    system = createPluginSystem({ aiHomeDir, hostVersion: '1.0.0' });

    const installed = system.control.install(built.file);
    assert.equal(installed.pluginId, 'aih.sample.echo');
    assert.equal(installed.version, '0.1.0');

    const enabled = await system.control.enable({ pluginId: installed.pluginId });
    assert.equal(enabled.state, 'active');
    assert.ok(enabled.generation > 0);

    const firstCall = await system.runtime.invoke('sample.echo.call', { marker: 'AIH_PLUGIN_DEMO_OK' }, {
      timeoutMs: 2000
    });
    assert.equal(firstCall.value.echoed.marker, 'AIH_PLUGIN_DEMO_OK');
    assert.equal(firstCall.value.instanceId, 'aih.sample.echo');

    await system.runtime.stop();
    system = null;

    recovered = createPluginSystem({ aiHomeDir, hostVersion: '1.0.0' });
    const recovery = await recovered.runtime.start();
    assert.equal(recovery.state, 'active');
    const recoveredCall = await recovered.runtime.invoke('sample.echo.call', { marker: 'AIH_PLUGIN_RECOVERED_OK' }, {
      timeoutMs: 2000
    });
    assert.equal(recoveredCall.value.echoed.marker, 'AIH_PLUGIN_RECOVERED_OK');

    const instanceId = 'aih.sample.echo';
    const disabled = await recovered.control.disable({ instanceId, remove: true });
    assert.equal(disabled.state, 'idle');
    await assert.rejects(
      () => recovered.runtime.invoke('sample.echo.call', {}, { timeoutMs: 1000 }),
      (error) => error && error.code === 'plugin_runtime_inactive'
    );

    const uninstall = recovered.control.uninstall({ pluginId: installed.pluginId });
    assert.equal(uninstall.pluginId, installed.pluginId);
    const report = recovered.control.doctor();
    assert.equal(report.ok, true);
    assert.equal(report.installed.length, 0);
  } finally {
    await stopSystem(system);
    await stopSystem(recovered);
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('AIH plugin uninstall remains protected while an instance is enabled', async () => {
  const aiHomeDir = temporaryHome();
  const artifactFile = path.join(aiHomeDir, 'echo.aih-plugin');
  let system = null;
  try {
    buildArtifact(ECHO_DIR, artifactFile, { hostVersion: '1.0.0' });
    system = createPluginSystem({ aiHomeDir, hostVersion: '1.0.0' });
    system.control.install(artifactFile);
    await system.control.enable({ pluginId: 'aih.sample.echo' });
    assert.throws(
      () => system.control.uninstall({ pluginId: 'aih.sample.echo' }),
      (error) => error && error.code === 'plugin_in_use'
    );
  } finally {
    await stopSystem(system);
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});
