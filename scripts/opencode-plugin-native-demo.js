'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createNativePluginManager } = require('../lib/native-resources/native-plugin-manager');
const execute = promisify(execFile);
const MARKER = 'AIH_PLUGIN_DEMO_OK:portable-input';

async function runOpenCodePluginDemo(binary = 'opencode', dependencyDir = path.join(os.homedir(), '.config/opencode')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-plugin-'));
  const host = path.join(root, 'home');
  const work = path.join(root, 'work');
  const observations = [];
  const server = http.createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error('fixture_payload_limit'); }
      const request = JSON.parse(body || '{}');
      const registered = request.tools?.some(tool => tool.function?.name === 'aih_demo') || false;
      const toolResult = request.messages?.find(message => message.role === 'tool' && JSON.stringify(message.content).includes(MARKER));
      observations.push({ registered, result: Boolean(toolResult) });
      const delta = registered && !toolResult
        ? { tool_calls: [{ index: 0, id: 'demo-call', type: 'function', function: { name: 'aih_demo', arguments: '{}' } }] }
        : { content: toolResult ? MARKER : 'PLUGIN_NOT_LOADED' };
      const finish = delta.tool_calls ? 'tool_calls' : 'stop';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = (value, reason) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      res.end(frame(delta, null) + frame({}, finish) + 'data: [DONE]\n\n');
    } catch (_) { res.writeHead(400); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { PATH: process.env.PATH, HOME: host, USERPROFILE: host, TERM: 'dumb', NO_PROXY: '127.0.0.1,localhost', XDG_CONFIG_HOME: path.join(host, '.config'), XDG_DATA_HOME: path.join(host, '.local/share'), XDG_CACHE_HOME: path.join(host, '.cache') };
  Object.assign(env, { npm_config_fetch_retries: '0', npm_config_fetch_timeout: '10000', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1' });
  try {
    fs.mkdirSync(work, { recursive: true });
    const configDir = path.join(host, '.config/opencode');
    fs.mkdirSync(configDir, { recursive: true });
    // Only package artifacts are copied; native config, auth and npmrc stay out.
    const sdkFile = path.join(dependencyDir, 'node_modules/@opencode-ai/plugin/package.json');
    let sdkVersion;
    if (fs.existsSync(sdkFile)) {
      sdkVersion = JSON.parse(fs.readFileSync(sdkFile)).version;
      for (const file of ['package.json', 'package-lock.json', 'node_modules']) {
        fs.cpSync(path.join(dependencyDir, file), path.join(configDir, file), { recursive: true, dereference: true, mode: fs.constants.COPYFILE_FICLONE });
      }
    }
    fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({
      model: 'fixture/demo', permission: { '*': 'allow' }, provider: { fixture: {
        npm: '@ai-sdk/openai-compatible', name: 'Local plugin fixture',
        options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key' },
        models: { demo: { name: 'Plugin demo', tool_call: true } }
      } }
    }));
    const manager = createNativePluginManager({ aiHomeDir: path.join(root, 'aih'), hostHomeDir: host });
    manager.install(path.resolve(__dirname, '../examples/native-plugins/aih-demo'), { provider: 'opencode' });
    const steps = [];
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      if (stage === 'disabled') manager.disable('aih-demo', { provider: 'opencode' });
      if (stage === 're-enabled') manager.enable('aih-demo', { provider: 'opencode' });
      if (stage === 'removed') manager.remove('aih-demo', { provider: 'opencode' });
      observations.length = 0;
      const { stdout } = await execute(binary, ['run', '--format', 'json', '--model', 'fixture/demo', 'Use the aih_demo tool if available.'], { cwd: work, env, timeout: 120000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      const expected = ['enabled', 're-enabled'].includes(stage);
      const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch (_) { return []; } });
      const toolEvent = events.some(event => event.type === 'tool_use' && event.part?.tool === 'aih_demo' && event.part?.state?.status === 'completed' && event.part?.state?.output === MARKER);
      assert.ok(observations.length > 0, 'real native inference fixture reached');
      assert.equal(observations.some(row => row.registered), expected, 'native plugin tool schema');
      assert.equal(observations.some(row => row.result), expected, 'native plugin execution result reached model');
      assert.equal(toolEvent, expected, 'native completed tool event');
      steps.push({ stage, toolSchema: expected, toolCall: toolEvent, resultObserved: expected, requests: observations.length, passed: true });
    }
    return { host: 'opencode', binary, version: (await execute(binary, ['--version'], { env, timeout: 5000 })).stdout.trim(), dependencySdk: sdkVersion || 'native bootstrap', inference: 'local-deterministic-tool-fixture', steps, passed: true };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (require.main === module) runOpenCodePluginDemo(process.argv[2], process.argv[3]).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { runOpenCodePluginDemo };
