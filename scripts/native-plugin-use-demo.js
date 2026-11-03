'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNativePluginManager } = require('../lib/native-resources/native-plugin-manager');
const { createPromptFixture } = require('../examples/skills/prompt-fixture');
const { NATIVE_CLIENTS, runNativePrompt, finalAnswer } = require('./skill-native-demo');
const SOURCE = path.resolve(__dirname, '../examples/native-plugins/aih-demo');
const MARKER = 'AIH_PLUGIN_DEMO_OK';
const CLIENTS = {
  codex: { binary: '/Users/model/.codex/packages/standalone/current/bin/codex.aih-original', prompt: 'Use the $aih-demo:aih-demo skill. Reply only as instructed by that skill.' },
  claude: { binary: '/Users/model/.local/bin/claude', prompt: '/aih-demo:aih-demo' }
};

async function runNativePluginUseDemo(provider, binary = CLIENTS[provider]?.binary) {
  assert.ok(CLIENTS[provider], 'Usage: node scripts/native-plugin-use-demo.js codex|claude [native-binary]');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-plugin-use-'));
  const host = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = await createPromptFixture({ marker: MARKER, missing: 'PLUGIN_NOT_LOADED' });
  try {
    const launch = NATIVE_CLIENTS[provider]({ host, url: fixture.url, prompt: CLIENTS[provider].prompt });
    const env = { PATH: process.env.PATH, HOME: host, USERPROFILE: host, TERM: 'dumb', NO_PROXY: '127.0.0.1,localhost', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...launch.env };
    const manager = createNativePluginManager({ aiHomeDir: path.join(root, 'aih'), hostHomeDir: host, nativeBinaries: { [provider]: binary } });
    manager.install(SOURCE, { provider });
    const steps = [];
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      if (stage === 'disabled') manager.disable('aih-demo', { provider });
      if (stage === 're-enabled') manager.enable('aih-demo', { provider });
      if (stage === 'removed') manager.remove('aih-demo', { provider });
      fixture.observations.length = 0;
      const { output = '', ...result } = await runNativePrompt(binary, launch.args, { cwd, env });
      const expected = ['enabled', 're-enabled'].includes(stage);
      const loaded = fixture.observations.some(row => row.loaded);
      const marker = finalAnswer(output, provider) === MARKER;
      const step = { stage, ...result, requests: fixture.observations.length, pluginBodyObserved: loaded, marker };
      steps.push(step);
      assert.ok(!result.error && !result.timedOut && result.exitCode === 0 && fixture.observations.length > 0 && loaded === expected && marker === expected, JSON.stringify(step));
      step.passed = true;
    }
    assert.equal(manager.doctor({ provider }).healthy, true);
    return { provider, binary, inference: 'local-deterministic-native-plugin-fixture', steps, passed: true };
  } finally {
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/native-plugin-use-demo.js codex|claude [native-binary]');
  else runNativePluginUseDemo(process.argv[2], process.argv[3]).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { runNativePluginUseDemo };
