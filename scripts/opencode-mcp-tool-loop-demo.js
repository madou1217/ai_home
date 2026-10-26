'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createMcpManager } = require('../lib/native-resources/mcp-manager');
const { randomUUID } = require('node:crypto');
const executeFile = promisify(execFile);
function execute(binary, args, options) {
  const pending = executeFile(binary, args, options);
  // Non-interactive `opencode run` reads piped input until EOF before sending
  // its first request. execFile leaves that pipe open unless we close it.
  pending.child.stdin.end();
  return pending;
}
const MARKER = 'AIH_NATIVE_MCP_OK';

async function runOpenCodeMcpDemo(binary = 'opencode', dependencyDir = path.join(os.homedir(), '.config/opencode')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-mcp-'));
  const host = path.join(root, 'home');
  const work = path.join(root, 'work');
  const observations = [];
  const nonce = randomUUID();
  const filename = `native-mcp-${nonce}.txt`;
  const fixtureErrors = [];
  const server = http.createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error('fixture_payload_limit'); }
      const request = JSON.parse(body || '{}');
      const functions = (request.tools || []).map(tool => tool.function).filter(Boolean);
      const echo = functions.find(tool => tool.name.endsWith('aih_echo'));
      const files = functions.find(tool => tool.name.endsWith('aih_list_files'));
      const results = (request.messages || []).filter(message => message.role === 'tool');
      const echoed = results.some(message => message.tool_call_id === 'echo-call' && JSON.stringify(message.content).includes(nonce));
      const listed = results.some(message => message.tool_call_id === 'files-call' && JSON.stringify(message.content).includes(filename));
      observations.push({ echoSchema: Boolean(echo), filesSchema: Boolean(files), echoed, listed });
      assert.ok(observations.length <= 3, 'unexpected_extra_model_request');
      const selected = !echoed ? echo : !listed ? files : null;
      const delta = selected
        ? { tool_calls: [{ index: 0, id: echoed ? 'files-call' : 'echo-call', type: 'function', function: { name: selected.name, arguments: JSON.stringify(echoed ? { path: '.' } : { text: nonce }) } }] }
        : { content: echoed && listed ? MARKER : 'MCP_NOT_LOADED' };
      const finish = delta.tool_calls ? 'tool_calls' : 'stop';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = (value, reason) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'demo', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      res.end(frame(delta, null) + frame({}, finish) + 'data: [DONE]\n\n');
    } catch (error) { fixtureErrors.push(error.message); res.writeHead(400); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { PATH: process.env.PATH, HOME: host, USERPROFILE: host, TERM: 'dumb', NO_PROXY: '127.0.0.1,localhost', XDG_CONFIG_HOME: path.join(host, '.config'), XDG_DATA_HOME: path.join(host, '.local/share'), XDG_CACHE_HOME: path.join(host, '.cache') };
  Object.assign(env, { npm_config_fetch_retries: '0', npm_config_fetch_timeout: '10000' });
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, filename), 'Native MCP directory evidence.\n');
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
      model: 'fixture/demo', agent: { title: { disable: true } }, permission: { '*': 'deny', 'aih-demo*': 'allow' }, provider: { fixture: {
        npm: '@ai-sdk/openai-compatible', name: 'Local MCP fixture',
        options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-key' },
        models: { demo: { name: 'MCP demo', tool_call: true } }
      } }
    }));
    const manager = createMcpManager({ aiHomeDir: path.join(root, 'aih'), hostHomeDir: host });
    manager.add('aih-demo', { command: process.execPath, args: [path.resolve(__dirname, '../examples/mcp/aih-demo-server.js')] }, { provider: 'opencode' });
    manager.enable('aih-demo', { provider: 'opencode' });
    const steps = [];
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      if (stage === 'disabled') manager.disable('aih-demo', { provider: 'opencode' });
      if (stage === 're-enabled') manager.enable('aih-demo', { provider: 'opencode' });
      if (stage === 'removed') manager.remove('aih-demo', { provider: 'opencode' });
      observations.length = 0;
      const { stdout } = await execute(binary, ['run', '--format', 'json', '--model', 'fixture/demo', 'Use the available AIH MCP tools.'], { cwd: work, env, timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      const expected = ['enabled', 're-enabled'].includes(stage);
      const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch (_) { return []; } });
      const completed = events.filter(event => event.type === 'tool_use' && event.part?.state?.status === 'completed');
      const echoEvent = completed.some(event => event.part.tool.endsWith('aih_echo') && event.part.state.output.includes(nonce));
      const filesEvent = completed.some(event => event.part.tool.endsWith('aih_list_files') && event.part.state.output.includes(filename));
      const answer = events.filter(event => event.type === 'text').map(event => event.part?.text || '').join('').trim();
      assert.deepEqual(fixtureErrors, []);
      assert.equal(observations.length, expected ? 3 : 1, 'native MCP roundtrip count');
      assert.equal(observations.some(row => row.echoSchema), expected, 'native MCP echo schema');
      assert.equal(observations.some(row => row.filesSchema), expected, 'native MCP file-list schema');
      assert.equal(observations.some(row => row.echoed && row.listed), expected, 'both MCP results reached model');
      assert.equal(echoEvent, expected, 'native completed echo event');
      assert.equal(filesEvent, expected, 'native completed file-list event');
      assert.equal(answer, expected ? MARKER : 'MCP_NOT_LOADED', 'exact native final answer');
      steps.push({ stage, toolSchema: expected, echoExecuted: echoEvent, filesExecuted: filesEvent, resultsObserved: expected, requests: observations.length, answer, passed: true });
    }
    return { host: 'opencode', resource: 'mcp', binary, version: (await execute(binary, ['--version'], { env, timeout: 5000 })).stdout.trim(), dependencySdk: sdkVersion || 'native bootstrap', inference: 'local-deterministic-tool-fixture', toolExecutionVerified: true, steps, passed: true };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/opencode-mcp-tool-loop-demo.js [native-cli-path] [dependency-directory]');
  else runOpenCodeMcpDemo(process.argv[2], process.argv[3]).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { runOpenCodeMcpDemo };
