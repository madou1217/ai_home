'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildArtifact } = require('../lib/plugins/control/artifact');
const { createPluginSystem } = require('../lib/plugins/control/plugin-system');

const ECHO_DIR = path.join(__dirname, '..', 'examples', 'plugins', 'echo');

function result(stage, value) {
  return { stage, ...(value && typeof value === 'object' ? value : { value }) };
}

async function stop(system) {
  if (!system) return;
  try { await system.runtime.stop(); } catch (_error) {}
}

async function main() {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-plugin-demo-'));
  const artifactFile = path.join(aiHomeDir, 'echo.aih-plugin');
  let system = null;
  let recovered = null;
  const evidence = { aiHomeDir: '<temporary>', pluginId: 'aih.sample.echo', steps: [] };
  try {
    const packed = buildArtifact(ECHO_DIR, artifactFile, { hostVersion: '1.0.0' });
    evidence.steps.push(result('pack', { ok: true, bytes: packed.bytes, digest: packed.digest }));
    system = createPluginSystem({ aiHomeDir, hostVersion: '1.0.0' });
    evidence.steps.push(result('install', system.control.install(artifactFile)));
    evidence.steps.push(result('enable', await system.control.enable({ pluginId: 'aih.sample.echo' })));
    const call = await system.runtime.invoke('sample.echo.call', { marker: 'AIH_PLUGIN_DEMO_OK' }, { timeoutMs: 2000 });
    evidence.steps.push(result('use', { ok: true, marker: call.value.echoed.marker, generation: call.value.generation }));
    await system.runtime.stop();
    system = null;
    recovered = createPluginSystem({ aiHomeDir, hostVersion: '1.0.0' });
    evidence.steps.push(result('restart', await recovered.runtime.start()));
    const afterRestart = await recovered.runtime.invoke('sample.echo.call', { marker: 'AIH_PLUGIN_RECOVERED_OK' }, { timeoutMs: 2000 });
    evidence.steps.push(result('use-after-restart', { ok: true, marker: afterRestart.value.echoed.marker, generation: afterRestart.value.generation }));
    evidence.steps.push(result('disable', await recovered.control.disable({ instanceId: 'aih.sample.echo', remove: true })));
    evidence.steps.push(result('uninstall', recovered.control.uninstall({ pluginId: 'aih.sample.echo' })));
    evidence.steps.push(result('doctor', recovered.control.doctor()));
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } finally {
    await stop(system);
    await stop(recovered);
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error && error.stack || error}\n`);
  process.exitCode = 1;
});

module.exports = { main };
