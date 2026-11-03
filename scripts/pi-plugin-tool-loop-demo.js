'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createNativePluginManager } = require('../lib/native-resources/native-plugin-manager');
const { findRuntimePackage } = require('../lib/native-resources/host-runtime-discovery');
const { IMPORTED_HOSTS } = require('../lib/native-resources/provider-resource-doctor');
const { runNativePrompt } = require('./skill-native-demo');
const { preparePiHarness } = require('../lib/harness/pi');

const { createToolLoopFixture, MARKER, MISSING } = require('../examples/native-plugins/tool-loop-fixture');

async function runPiToolLoopDemo(runtimePackage) {
  runtimePackage ||= findRuntimePackage(IMPORTED_HOSTS.find(row => row.host === 'pi'), { hostHomeDir: os.homedir() })?.packageDir;
  assert.ok(runtimePackage, 'pi_runtime_required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-pi-tool-loop-'));
  const home = path.join(root, 'home');
  const agentDir = path.join(home, '.pi/agent');
  const { server, observations, fixtureErrors } = createToolLoopFixture();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    fs.mkdirSync(agentDir, { recursive: true });
    const aiHomeDir = path.join(root, 'aih');
    const manager = createNativePluginManager({ aiHomeDir, hostHomeDir: home });
    const cli = path.join(runtimePackage, 'dist/bundle/cli.js');
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TERM: 'dumb', NO_PROXY: '127.0.0.1,localhost', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' };
    const steps = [];
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      const action = { enabled: 'install', disabled: 'disable', 're-enabled': 'enable', removed: 'remove' }[stage];
      const managed = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/ai-home.js'), 'native', 'plugin', action, action === 'install' ? path.resolve(__dirname, '../examples/native-plugins/aih-demo') : 'aih-demo', '--host', 'pi', '--json'], { cwd: root, env: { ...env, AIH_HOME_DIR: aiHomeDir }, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
      assert.equal(managed.status, 0, 'managed_cli_lifecycle_failed');
      assert.equal(JSON.parse(managed.stdout).ok, true);
      const prepared = await preparePiHarness({
        aiHomeDir, hostHomeDir: home, accountRef: 'acct_demo', provider: 'codex', model: 'demo',
        gateway: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key' },
        catalog: { models: [{ id: 'demo', contextWindow: 32000, maxTokens: 1024 }] }
      });
      observations.length = 0;
      const result = await runNativePrompt(process.execPath, [cli, ...prepared.args, '--print', '--mode', 'json', '--no-session', '--no-builtin-tools', '--no-context-files', '--no-skills', '--no-prompt-templates', '--offline', 'Use the aih_demo tool if available.'], { cwd: root, env: { ...env, ...prepared.env } });
      assert.equal(result.exitCode, 0, 'pi_native_exit');
      assert.equal(result.timedOut, false, 'pi_native_timeout');
      assert.deepEqual(fixtureErrors, [], 'fixture_errors');
      assert.ok(observations.length > 0, 'native_request_missing');
      const events = result.output.split('\n').filter(Boolean).map(line => JSON.parse(line));
      const expected = stage === 'enabled' || stage === 're-enabled';
      const toolEvent = events.find(event => event.type === 'tool_execution_end' && event.toolName === 'aih_demo');
      const answer = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').at(-1)?.message;
      const text = answer?.content?.filter(part => part.type === 'text').map(part => part.text).join('');
      assert.equal(observations.some(row => row.toolSchema), expected, 'native_tool_schema');
      assert.equal(observations.some(row => row.toolResult), expected, 'tool_result_returned_to_model');
      assert.equal(Boolean(toolEvent), expected, 'native_tool_execution_event');
      if (toolEvent) {
        assert.equal(toolEvent.isError, false);
        assert.equal(toolEvent.result?.content?.[0]?.text, MARKER);
      }
      assert.equal(text, expected ? MARKER : MISSING, 'native_final_answer');
      assert.equal(manager.doctor({ host: 'pi' }).healthy, true);
      steps.push({ stage, managedCli: true, accountHarness: true, requests: observations.length, toolSchema: expected, toolExecuted: Boolean(toolEvent), resultReturned: expected, finalAnswer: text, exitCode: result.exitCode, passed: true });
    }
    return { host: 'pi', version: JSON.parse(fs.readFileSync(path.join(runtimePackage, 'package.json'))).version, inference: 'local-deterministic-tool-fixture', toolExecutionVerified: true, steps, passed: true };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/pi-plugin-tool-loop-demo.js [installed-pi-package-directory]');
  else runPiToolLoopDemo(process.argv[2]).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
module.exports = { runPiToolLoopDemo };
