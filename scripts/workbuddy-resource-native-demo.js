'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { createNativePluginManager } = require('../lib/native-resources/native-plugin-manager');
const { createSkillManager } = require('../lib/native-resources/skill-manager');
const { createMcpManager } = require('../lib/native-resources/mcp-manager');
const { resolveProviderResourceRuntime, nativeResourceEnvironment } = require('../lib/native-resources/provider-native-runtime');
const { createPromptFixture } = require('../examples/skills/prompt-fixture');
const { runNativePrompt } = require('./skill-native-demo');

const PROVIDER = 'workbuddy';
const SOURCE = path.resolve(__dirname, '../examples/native-plugins/aih-demo');
const SKILL_SOURCE = path.resolve(__dirname, '../assets/provider-skills/aih-demo');
const MCP_SERVER = path.resolve(__dirname, '../examples/mcp/aih-demo-server.js');

function invoke(runtime, env, cwd, prompt) {
  return runNativePrompt(runtime.command, [...runtime.args, '-p', prompt, '--model', 'primary-model', '--output-format', 'json', '--no-session-persistence', '--max-turns', '2'], { cwd, env });
}

function verifyRun(run, fixture, expected, marker, missing) {
  assert.equal(run.exitCode, 0, 'native_prompt_failed');
  assert.equal(run.timedOut, false, 'native_prompt_timeout');
  assert.ok(fixture.observations.length > 0, 'native_request_missing');
  const events = JSON.parse(run.output);
  assert.ok(Array.isArray(events), 'native_result_invalid');
  const result = events.filter(event => event.type === 'result').at(-1);
  assert.ok(result && !result.is_error, 'native_result_failed');
  assert.equal(result.result?.trim(), expected ? marker : missing);
  const loaded = fixture.observations.some(row => row.loaded);
  assert.equal(loaded, expected);
  return { exitCode: run.exitCode, timedOut: run.timedOut, requestCount: fixture.observations.length, marker: result.result.trim() === marker, loaded };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-workbuddy-resource-demo-'));
  let fixture;
  let skillFixture;
  try {
  const home = path.join(root, 'home');
  const aiHomeDir = path.join(root, 'aih');
  const runtime = resolveProviderResourceRuntime(PROVIDER, { hostHomeDir: home });
  assert.ok(runtime, 'workbuddy_runtime_required');
  fs.mkdirSync(home, { recursive: true });
  fixture = await createPromptFixture({ marker: 'AIH_PLUGIN_DEMO_OK', missing: 'PLUGIN_NOT_LOADED' });
  skillFixture = await createPromptFixture({ marker: 'AIH_SKILL_DEMO_OK', missing: 'SKILL_NOT_LOADED' });
  const baseEnv = nativeResourceEnvironment(PROVIDER, { hostHomeDir: home, env: { PATH: process.env.PATH } }, runtime);
  const env = { ...baseEnv, NO_PROXY: '127.0.0.1,localhost', CODEBUDDY_API_KEY: 'fixture-key', CODEBUDDY_BASE_URL: fixture.url };
  const skillEnv = { ...baseEnv, NO_PROXY: '127.0.0.1,localhost', CODEBUDDY_API_KEY: 'fixture-key', CODEBUDDY_BASE_URL: skillFixture.url };
  const pluginManager = createNativePluginManager({ aiHomeDir, hostHomeDir: home });
  const skillManager = createSkillManager({ aiHomeDir, hostHomeDir: home });
  const mcpManager = createMcpManager({ aiHomeDir, hostHomeDir: home });
  const version = childProcess.spawnSync(runtime.command, [...runtime.args, '--version'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(version.status, 0);
  const result = { host: PROVIDER, runtime: version.stdout.trim(), runtimeSource: runtime.source, stages: [], passed: false };
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      if (stage === 'enabled') pluginManager.install(SOURCE, { provider: PROVIDER });
      if (stage === 'disabled') pluginManager.disable('aih-demo', { provider: PROVIDER });
      if (stage === 're-enabled') pluginManager.enable('aih-demo', { provider: PROVIDER });
      if (stage === 'removed') pluginManager.remove('aih-demo', { provider: PROVIDER });
      fixture.observations.length = 0;
      const run = await invoke(runtime, env, root, '/aih-demo');
      const expected = stage === 'enabled' || stage === 're-enabled';
      const { loaded, ...evidence } = verifyRun(run, fixture, expected, 'AIH_PLUGIN_DEMO_OK', 'PLUGIN_NOT_LOADED');
      result.stages.push({ stage, pluginBodyObserved: loaded, ...evidence, passed: true });
    }

    const skillStages = [];
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      if (stage === 'enabled') skillManager.install(SKILL_SOURCE, { provider: PROVIDER });
      if (stage === 'disabled') skillManager.disable('aih-demo', { provider: PROVIDER });
      if (stage === 're-enabled') skillManager.enable('aih-demo', { provider: PROVIDER });
      if (stage === 'removed') skillManager.remove('aih-demo', { provider: PROVIDER });
      skillFixture.observations.length = 0;
      const run = await invoke(runtime, skillEnv, root, '/aih-demo');
      const expected = stage === 'enabled' || stage === 're-enabled';
      const { loaded, ...evidence } = verifyRun(run, skillFixture, expected, 'AIH_SKILL_DEMO_OK', 'SKILL_NOT_LOADED');
      skillStages.push({ stage, skillBodyObserved: loaded, ...evidence, passed: true });
    }
    result.skillStages = skillStages;

    const server = { command: process.execPath, args: [MCP_SERVER] };
    mcpManager.add('aih-demo', server, { provider: PROVIDER });
    const mcpTest = await mcpManager.test('aih-demo', { provider: PROVIDER });
    const mcpTools = await mcpManager.tools('aih-demo', { provider: PROVIDER });
    const mcpCall = await mcpManager.call('aih-demo', 'aih_echo', { text: 'WORKBUDDY_MCP_OK' }, { provider: PROVIDER });
    assert.deepEqual(mcpTools.map(tool => tool.name), ['aih_echo', 'aih_list_files']);
    assert.equal(mcpCall.content?.[0]?.text, 'WORKBUDDY_MCP_OK');
    const filesCall = await mcpManager.call('aih-demo', 'aih_list_files', { path: '.' }, { provider: PROVIDER });
    assert.ok(!filesCall.isError && filesCall.content?.[0]?.text, 'mcp_list_files_failed');
    mcpManager.enable('aih-demo', { provider: PROVIDER });
    const nativeList = childProcess.spawnSync(runtime.command, [...runtime.args, 'mcp', 'list'], { cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 256000 });
    assert.equal(nativeList.status, 0, nativeList.stderr);
    assert.match(nativeList.stdout, /aih-demo[^\n]*\bConnected\b/);
    mcpManager.disable('aih-demo', { provider: PROVIDER });
    mcpManager.remove('aih-demo', { provider: PROVIDER });
    result.mcp = { tools: mcpTools.map(tool => tool.name), call: mcpCall.content[0].text, filesCall: filesCall.content[0].text, nativeConnected: true, serverInfo: mcpTest.serverInfo, passed: true };
    result.passed = true;
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await fixture?.close();
    await skillFixture?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/workbuddy-resource-native-demo.js');
  else main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}

module.exports = { main };
