'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('yaml');
const { findRuntimePackage } = require('../lib/native-resources/host-runtime-discovery');
const { IMPORTED_HOSTS } = require('../lib/native-resources/provider-resource-doctor');
const { buildDshWrapperSource, resolveDshNodePath } = require('../lib/harness/dsh');
const { buildManagedHostPluginArgs } = require('../lib/native-resources/host-plugin-runtime');
const { createNativePluginManager } = require('../lib/native-resources/native-plugin-manager');
const { runNativePrompt } = require('./skill-native-demo');
const { createToolLoopFixture, MARKER, MISSING } = require('../examples/native-plugins/tool-loop-fixture');

async function runDeepSeekToolLoopDemo(runtimePackage) {
  runtimePackage ||= findRuntimePackage(IMPORTED_HOSTS.find(row => row.host === 'deepseek'), { hostHomeDir: os.homedir() })?.packageDir;
  assert.ok(runtimePackage, 'dsh_runtime_required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-dsh-tool-loop-'));
  const home = path.join(root, 'home');
  const aiHomeDir = path.join(root, 'aih');
  const dshHome = path.join(home, '.dsh');
  const profile = path.join(dshHome, 'profiles/demo');
  const entry = path.join(runtimePackage, 'lib/bin.js');
  const { server, observations, fixtureErrors } = createToolLoopFixture();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'aih-dsh-tool-loop', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }));
    fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), yaml.stringify([
      { id: 'llm-pi-ai', config: { providers: { fixture: { api: 'openai-completions', apiKeyEnv: 'OPENAI_API_KEY', baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'demo', contextWindow: 32000, maxTokens: 1024 }] } } } },
      { id: 'agent-default-model', config: { provider: 'fixture', model: 'demo' } },
      { id: 'session-telemetry-otel', disabled: true },
      { id: 'otel', disabled: true },
      { id: 'session-title-llm', disabled: true }
    ]));
    const launcher = path.join(root, 'run-dsh.mjs');
    fs.writeFileSync(launcher, buildDshWrapperSource(entry));
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TERM: 'dumb', NO_PROXY: '127.0.0.1,localhost', AIH_HOME_DIR: aiHomeDir, DSH_HOME: dshHome, NODE_PATH: resolveDshNodePath(entry), OPENAI_API_KEY: 'fixture-key', DSH_TOOLS_MODE: 'native' };
    const manager = createNativePluginManager({ aiHomeDir, hostHomeDir: home });
    const steps = [];
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      const action = { enabled: 'install', disabled: 'disable', 're-enabled': 'enable', removed: 'remove' }[stage];
      const managed = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/ai-home.js'), 'native', 'plugin', action, action === 'install' ? path.resolve(__dirname, '../examples/native-plugins/aih-demo') : 'aih-demo', '--host', 'deepseek', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
      assert.equal(managed.status, 0, 'managed_cli_lifecycle_failed');
      assert.equal(JSON.parse(managed.stdout).ok, true);
      const pluginArgs = buildManagedHostPluginArgs({ host: 'deepseek', aiHomeDir, hostHomeDir: home });
      observations.length = 0;
      const result = await runNativePrompt(process.execPath, [launcher, '--profile', 'demo', ...pluginArgs, '--json', 'Use the aih_demo tool if available.'], { cwd: root, env });
      assert.equal(result.exitCode, 0, 'dsh_native_exit');
      assert.equal(result.timedOut, false, 'dsh_native_timeout');
      assert.deepEqual(fixtureErrors, [], 'fixture_errors');
      const expected = stage === 'enabled' || stage === 're-enabled';
      assert.equal(observations.length, expected ? 2 : 1, 'native_request_count');
      assert.equal(observations.some(row => row.toolSchema), expected, 'native_tool_schema');
      assert.equal(observations.some(row => row.toolResult), expected, 'tool_result_returned_to_model');
      const events = result.output.split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.ok(!events.some(event => event.type === 'error'), 'native_error_event');
      const call = events.find(event => event.type === 'tool_call' && event.tool === 'aih_demo');
      const returned = events.find(event => event.type === 'tool_result' && event.callId === call?.callId);
      assert.equal(Boolean(call), expected);
      if (expected) {
        assert.equal(returned?.status, 'completed');
        assert.equal(returned.result, MARKER);
      }
      const final = events.filter(event => event.type === 'final').at(-1)?.text;
      assert.equal(final, expected ? MARKER : MISSING);
      assert.equal(manager.doctor({ host: 'deepseek' }).healthy, true);
      steps.push({ stage, managedCli: true, profile: 'isolated-official-headless', requests: observations.length, toolSchema: expected, toolExecuted: Boolean(call), resultReturned: expected, finalAnswer: final, exitCode: result.exitCode, passed: true });
    }
    return { host: 'deepseek', version: JSON.parse(fs.readFileSync(path.join(runtimePackage, 'package.json'))).version, inference: 'local-deterministic-tool-fixture', toolExecutionVerified: true, steps, passed: true };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/deepseek-plugin-tool-loop-demo.js [installed-dsh-package-directory]');
  else runDeepSeekToolLoopDemo(process.argv[2]).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
module.exports = { runDeepSeekToolLoopDemo };
