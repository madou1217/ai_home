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
const { runProcess } = require('./process-runner');

const SOURCE = path.resolve(__dirname, '../examples/native-plugins/aih-demo');
const SKILL_SOURCE = path.resolve(__dirname, '../assets/provider-skills/aih-demo');
const MCP_SERVER = path.resolve(__dirname, '../examples/mcp/aih-demo-server.js');

async function removeRoot(root) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 1, retryDelay: 100 });
      return;
    } catch (error) {
      if (attempt === 15) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function invoke(runtime, env, cwd, prompt) {
  // Stream JSON keeps the native result observable even when a host emits a
  // large tool transcript. Some CodeBuddy builds buffer a pretty JSON array
  // and can leave that array unterminated when the process exits after a tool
  // turn; line-delimited events preserve the completed result event.
  return runNativePrompt(runtime.command, [...runtime.args, '-p', prompt, '--model', 'primary-model', '--output-format', 'stream-json', '--no-session-persistence', '--max-turns', '2'], {
    cwd,
    env,
    stopWhen: (output) => /"type"\s*:\s*"result"/.test(output)
  });
}

function listNativeMcp(runtime, env, cwd, expectedEnabled) {
  return runProcess(runtime.command, [...runtime.args, 'mcp', 'list'], {
    cwd,
    env,
    timeoutMs: 30000,
    maxOutput: 256000,
    // The native host can keep an MCP stdio worker alive after printing the
    // complete list. The list output is the evidence boundary; terminate the
    // supervised process group as soon as that boundary is observable.
    stopWhen: (output) => {
      const text = String(output || '');
      return expectedEnabled
        ? /aih-demo[^\n]*\bConnected\b/.test(text)
        : /No MCP servers configured\./.test(text) || !text.includes('aih-demo');
    }
  });
}

function parseNativeEvents(output) {
  const text = String(output || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_error) {
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch (_lineError) { return []; }
    });
  }
}

function verifyRun(run, fixture, expected, marker, missing) {
  assert.equal(run.exitCode, 0, 'native_prompt_failed');
  assert.equal(run.timedOut, false, 'native_prompt_timeout');
  assert.ok(fixture.observations.length > 0, 'native_request_missing');
  const events = parseNativeEvents(run.output);
  assert.ok(events.length > 0, 'native_result_invalid');
  const result = events.filter(event => event.type === 'result').at(-1);
  assert.ok(result && !result.is_error, 'native_result_failed');
  assert.equal(result.result?.trim(), expected ? marker : missing);
  const loaded = fixture.observations.some(row => row.loaded);
  assert.equal(loaded, expected);
  return { exitCode: run.exitCode, timedOut: run.timedOut, requestCount: fixture.observations.length, skillToolRequested: fixture.observations.some(row => row.skillToolRequested), marker: result.result.trim() === marker, loaded };
}

async function main(options = {}) {
  const provider = options.provider || 'workbuddy';
  const nativeBinaries = options.binary ? { [provider]: options.binary } : undefined;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `aih-${provider}-resource-demo-`));
  let fixture;
  let skillFixture;
  try {
    const home = path.join(root, 'home');
    const aiHomeDir = path.join(root, 'aih');
    const runtime = resolveProviderResourceRuntime(provider, { hostHomeDir: home, nativeBinaries });
    assert.ok(runtime, 'native_runtime_required');
    fs.mkdirSync(home, { recursive: true });
    fixture = await createPromptFixture({ marker: 'AIH_PLUGIN_DEMO_OK', missing: 'PLUGIN_NOT_LOADED', invokeSkill: true });
    skillFixture = await createPromptFixture({ marker: 'AIH_SKILL_DEMO_OK', missing: 'SKILL_NOT_LOADED', invokeSkill: true });
    const baseEnv = nativeResourceEnvironment(provider, { hostHomeDir: home, env: { PATH: process.env.PATH } }, runtime);
    const env = { ...baseEnv, NO_PROXY: '127.0.0.1,localhost', CODEBUDDY_API_KEY: 'fixture-key', CODEBUDDY_BASE_URL: fixture.url };
    const skillEnv = { ...baseEnv, NO_PROXY: '127.0.0.1,localhost', CODEBUDDY_API_KEY: 'fixture-key', CODEBUDDY_BASE_URL: skillFixture.url };
    const pluginManager = createNativePluginManager({ aiHomeDir, hostHomeDir: home, nativeBinaries });
    const skillManager = createSkillManager({ aiHomeDir, hostHomeDir: home });
    const mcpManager = createMcpManager({ aiHomeDir, hostHomeDir: home });
    const version = await runProcess(runtime.command, [...runtime.args, '--version'], { env, cwd: root, timeoutMs: 30000, maxOutput: 256000 });
    assert.equal(version.status, 0);
    const result = { host: provider, runtime: version.stdout.trim(), runtimeSource: runtime.source, stages: [], passed: false };
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      if (stage === 'enabled') pluginManager.install(SOURCE, { provider });
      if (stage === 'disabled') pluginManager.disable('aih-demo', { provider });
      if (stage === 're-enabled') pluginManager.enable('aih-demo', { provider });
      if (stage === 'removed') pluginManager.remove('aih-demo', { provider });
      fixture.observations.length = 0;
      const run = await invoke(runtime, env, root, '/aih-demo');
      const expected = stage === 'enabled' || stage === 're-enabled';
      const { loaded, ...evidence } = verifyRun(run, fixture, expected, 'AIH_PLUGIN_DEMO_OK', 'PLUGIN_NOT_LOADED');
      const loadingMode = evidence.skillToolRequested ? 'native-skill-tool' : loaded ? 'direct-expansion' : 'absent';
      if (evidence.skillToolRequested) {
        assert.equal(expected, true, 'disabled_skill_tool_requested');
        assert.equal(evidence.requestCount, 2, 'native_skill_tool_roundtrip_missing');
        assert.deepEqual(fixture.observations.map(row => row.loaded), [false, true]);
      } else {
        assert.equal(evidence.requestCount, 1, 'unexpected_direct_request_count');
      }
      result.stages.push({ stage, loadingMode, pluginBodyObserved: loaded, ...evidence, passed: true });
    }

    const skillStages = [];
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      if (stage === 'enabled') skillManager.install(SKILL_SOURCE, { provider });
      if (stage === 'disabled') skillManager.disable('aih-demo', { provider });
      if (stage === 're-enabled') skillManager.enable('aih-demo', { provider });
      if (stage === 'removed') skillManager.remove('aih-demo', { provider });
      skillFixture.observations.length = 0;
      const run = await invoke(runtime, skillEnv, root, '/aih-demo');
      const expected = stage === 'enabled' || stage === 're-enabled';
      const { loaded, ...evidence } = verifyRun(run, skillFixture, expected, 'AIH_SKILL_DEMO_OK', 'SKILL_NOT_LOADED');
      skillStages.push({ stage, skillBodyObserved: loaded, ...evidence, passed: true });
    }
    result.skillStages = skillStages;

    const server = { command: process.execPath, args: [MCP_SERVER] };
    mcpManager.add('aih-demo', server, { provider });
    const mcpTest = await mcpManager.test('aih-demo', { provider });
    const mcpTools = await mcpManager.tools('aih-demo', { provider });
    const mcpCall = await mcpManager.call('aih-demo', 'aih_echo', { text: 'AIH_RESOURCE_MCP_OK' }, { provider });
    assert.deepEqual(mcpTools.map(tool => tool.name), ['aih_echo', 'aih_list_files']);
    assert.equal(mcpCall.content?.[0]?.text, 'AIH_RESOURCE_MCP_OK');
    const filesCall = await mcpManager.call('aih-demo', 'aih_list_files', { path: '.' }, { provider });
    assert.ok(!filesCall.isError && filesCall.content?.[0]?.text, 'mcp_list_files_failed');
    mcpManager.enable('aih-demo', { provider });
    const nativeList = await listNativeMcp(runtime, env, root, true);
    assert.equal(nativeList.status, 0, nativeList.stderr);
    assert.match(nativeList.stdout, /aih-demo[^\n]*\bConnected\b/);
    mcpManager.disable('aih-demo', { provider });
    const disabledList = await listNativeMcp(runtime, env, root, false);
    assert.equal(disabledList.status, 0, disabledList.stderr);
    assert.doesNotMatch(disabledList.stdout, /aih-demo/);
    mcpManager.remove('aih-demo', { provider });
    result.mcp = { tools: mcpTools.map(tool => tool.name), call: mcpCall.content[0].text, filesCall: filesCall.content[0].text, nativeConnected: true, nativeAbsentAfterDisable: true, serverInfo: mcpTest.serverInfo, passed: true };
    result.passed = true;
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await fixture?.close();
    await skillFixture?.close();
    // CodeBuddy may finish its result event before the native child that owns
    // the config directory exits. Retry cleanup until that process group has
    // released the isolated home; a passed tool loop with a leaked child is
    // not a stable demo result.
    await removeRoot(root);
  }
}

if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/workbuddy-resource-native-demo.js [--provider <id>] [--binary <path>]');
  else {
    const value = flag => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;
    main({ provider: value('--provider'), binary: value('--binary') }).catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
  }
}

module.exports = { main };
