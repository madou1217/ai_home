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
  // Close stdin so a headless client cannot wait indefinitely for input.
  pending.child.stdin.end();
  return pending;
}
const MARKER = 'AIH_NATIVE_MCP_OK';
const expectedStage = stage => stage === 'enabled' || stage === 're-enabled';

async function runCodexMcpDemo(binary = 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-mcp-'));
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
      const functions = (request.tools || []).flatMap(tool => tool.type === 'namespace' ? (tool.tools || []).map(entry => ({ ...entry, namespace: tool.name })) : [tool]);
      const echo = functions.find(tool => tool.namespace === 'mcp__aih_demo' && tool.name === 'aih_echo');
      const files = functions.find(tool => tool.namespace === 'mcp__aih_demo' && tool.name === 'aih_list_files');
      const results = (request.input || []).filter(item => item.type === 'function_call_output');
      const echoed = results.some(message => message.call_id === 'echo-call' && JSON.stringify(message.output).includes(nonce));
      const listed = results.some(message => message.call_id === 'files-call' && JSON.stringify(message.output).includes(filename));
      observations.push({ echoSchema: Boolean(echo), filesSchema: Boolean(files), echoed, listed });
      assert.ok(observations.length <= 3, 'unexpected_extra_model_request');
      const selected = !echoed ? echo : !listed ? files : null;
      const item = selected
        ? { type: 'function_call', id: echoed ? 'fc_files' : 'fc_echo', call_id: echoed ? 'files-call' : 'echo-call', name: selected.name, ...(selected.namespace ? { namespace: selected.namespace } : {}), arguments: JSON.stringify(echoed ? { path: '.' } : { text: nonce }), status: 'completed' }
        : { type: 'message', id: 'msg_final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: echoed && listed ? MARKER : 'MCP_NOT_LOADED', annotations: [] }] };
      const response = { id: `resp_${observations.length}`, object: 'response', created_at: Math.floor(Date.now() / 1000), model: request.model, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      emit('response.created', { response: { ...response, status: 'in_progress', output: [] } });
      emit('response.output_item.added', { output_index: 0, item: selected ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } });
      if (selected) {
        emit('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
        emit('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments });
      } else {
        emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
        emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text });
        emit('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
      }
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', { response });
      res.end();
    } catch (error) { fixtureErrors.push(error.message); res.writeHead(400); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const configDir = path.join(host, '.codex');
  const env = { PATH: process.env.PATH, HOME: host, USERPROFILE: host, TERM: 'dumb', NO_PROXY: '127.0.0.1,localhost', CODEX_HOME: configDir };
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, filename), 'Native MCP directory evidence.\n');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.toml'), `model = "fixture-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local MCP fixture"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
    const manager = createMcpManager({ aiHomeDir: path.join(root, 'aih'), hostHomeDir: host });
    manager.add('aih-demo', { command: process.execPath, args: [path.resolve(__dirname, '../examples/mcp/aih-demo-server.js')] }, { provider: 'codex' });
    manager.enable('aih-demo', { provider: 'codex' });
    const steps = [];
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      if (stage === 'disabled') manager.disable('aih-demo', { provider: 'codex' });
      if (stage === 're-enabled') manager.enable('aih-demo', { provider: 'codex' });
      if (stage === 'removed') manager.remove('aih-demo', { provider: 'codex' });
      observations.length = 0;
      const expected = expectedStage(stage);
      const approvals = expected ? ['-c', 'mcp_servers.aih-demo.tools.aih_echo.approval_mode="approve"', '-c', 'mcp_servers.aih-demo.tools.aih_list_files.approval_mode="approve"'] : [];
      const { stdout } = await execute(binary, ['exec', ...approvals, '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--json', 'Use the available AIH MCP tools.'], { cwd: work, env, timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch (_) { return []; } });
      const completed = events.filter(event => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call' && event.item?.status === 'completed' && event.item.server === 'aih-demo' && !event.item.error && !event.item.result?.isError);
      const echoEvent = completed.some(event => event.item.tool === 'aih_echo' && JSON.stringify(event.item.result).includes(nonce));
      const filesEvent = completed.some(event => event.item.tool === 'aih_list_files' && JSON.stringify(event.item.result).includes(filename));
      const answer = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').map(event => event.item.text).join('').trim();
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
    return { host: 'codex', resource: 'mcp', binary, version: (await execute(binary, ['--version'], { env, timeout: 5000 })).stdout.trim(), inference: 'local-deterministic-tool-fixture', toolExecutionVerified: true, steps, passed: true };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/codex-mcp-tool-loop-demo.js [native-cli-path]');
  else runCodexMcpDemo(process.argv[2]).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { runCodexMcpDemo };
