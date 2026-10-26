'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createNativePluginManager } = require('../lib/native-resources/native-plugin-manager');
const { findRuntimePackage } = require('../lib/native-resources/host-runtime-discovery');
const { IMPORTED_HOSTS } = require('../lib/native-resources/provider-resource-doctor');
const { runNativePrompt } = require('./skill-native-demo');

const MARKER = 'AIH_PLUGIN_DEMO_OK:portable-input';
const MISSING = 'PLUGIN_NOT_LOADED';

async function runPiToolLoopDemo(runtimePackage) {
  runtimePackage ||= findRuntimePackage(IMPORTED_HOSTS.find(row => row.host === 'pi'), { hostHomeDir: os.homedir() })?.packageDir;
  assert.ok(runtimePackage, 'pi_runtime_required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-pi-tool-loop-'));
  const home = path.join(root, 'home');
  const agentDir = path.join(home, '.pi/agent');
  const observations = [];
  const fixtureErrors = [];
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        assert.ok(Buffer.byteLength(body) <= 1024 * 1024, 'fixture_payload_limit');
      }
      const request = JSON.parse(body);
      const toolSchema = request.tools?.some(tool => tool.function?.name === 'aih_demo') || false;
      const toolResult = request.messages?.some(message => message.role === 'tool' && message.content === MARKER) || false;
      observations.push({ toolSchema, toolResult });
      assert.ok(observations.length <= 4, 'fixture_tool_loop_limit');
      const delta = toolSchema && !toolResult
        ? { tool_calls: [{ index: 0, id: 'portable-call', type: 'function', function: { name: 'aih_demo', arguments: JSON.stringify({ text: 'portable-input' }) } }] }
        : { content: toolResult ? MARKER : MISSING };
      const frame = (value, finishReason) => `data: ${JSON.stringify({ id: 'pi-fixture', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta: value, finish_reason: finishReason }] })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(frame({ role: 'assistant', ...delta }, null) + frame({}, delta.tool_calls ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    } catch (error) {
      fixtureErrors.push(error.message);
      res.writeHead(400); res.end('{}');
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture-key',
      models: [{ id: 'demo', reasoning: false, contextWindow: 32000, maxTokens: 1024 }]
    } } }));
    const manager = createNativePluginManager({ aiHomeDir: path.join(root, 'aih'), hostHomeDir: home });
    const cli = path.join(runtimePackage, 'dist/bundle/cli.js');
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TERM: 'dumb', NO_PROXY: '127.0.0.1,localhost', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' };
    const steps = [];
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      if (stage === 'enabled') manager.install(path.resolve(__dirname, '../examples/native-plugins/aih-demo'), { host: 'pi' });
      if (stage === 'disabled') manager.disable('aih-demo', { host: 'pi' });
      if (stage === 're-enabled') manager.enable('aih-demo', { host: 'pi' });
      if (stage === 'removed') manager.remove('aih-demo', { host: 'pi' });
      observations.length = 0;
      const result = await runNativePrompt(process.execPath, [cli, '--print', '--mode', 'json', '--no-session', '--no-builtin-tools', '--no-context-files', '--no-skills', '--no-prompt-templates', '--offline', '--provider', 'fixture', '--model', 'demo', 'Use the aih_demo tool if available.'], { cwd: root, env });
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
      steps.push({ stage, requests: observations.length, toolSchema: expected, toolExecuted: Boolean(toolEvent), resultReturned: expected, finalAnswer: text, exitCode: result.exitCode, passed: true });
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
