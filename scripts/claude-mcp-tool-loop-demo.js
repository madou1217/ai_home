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

async function runClaudeMcpDemo(binary = 'claude') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-mcp-'));
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
      const blocks = (request.messages || []).filter(message => message.role === 'user').flatMap(message => Array.isArray(message.content) ? message.content : []);
      const results = blocks.filter(block => block.type === 'tool_result' && !block.is_error);
      const searchResult = results.find(block => block.tool_use_id === 'search-call');
      const fetched = searchResult ? JSON.stringify(searchResult.content) : '';
      const functions = request.tools || [];
      const echoName = 'mcp__aih-demo__aih_echo';
      const filesName = 'mcp__aih-demo__aih_list_files';
      const echoAdvertised = blocks.some(block => block.type === 'text' && block.text?.includes(echoName));
      const filesAdvertised = blocks.some(block => block.type === 'text' && block.text?.includes(filesName));
      const advertised = echoAdvertised && filesAdvertised;
      const echo = functions.find(tool => tool.name === echoName) || (fetched.includes(echoName) ? { name: echoName } : null);
      const files = functions.find(tool => tool.name === filesName) || (fetched.includes(filesName) ? { name: filesName } : null);
      const search = !echo && advertised && functions.find(tool => tool.name === 'ToolSearch');
      const echoed = results.some(message => message.tool_use_id === 'echo-call' && JSON.stringify(message.content).includes(nonce));
      const listed = results.some(message => message.tool_use_id === 'files-call' && JSON.stringify(message.content).includes(filename));
      observations.push({ echoAdvertised, filesAdvertised, searched: Boolean(searchResult), echoSchema: Boolean(echo), filesSchema: Boolean(files), echoed, listed });
      assert.ok(observations.length <= 4, 'unexpected_extra_model_request');
      const selected = search || (!echoed ? echo : !listed ? files : null);
      const content = selected
        ? { type: 'tool_use', id: search ? 'search-call' : echoed ? 'files-call' : 'echo-call', name: selected.name, input: search ? { query: `select:${echoName},${filesName}`, max_results: 2 } : echoed ? { path: '.' } : { text: nonce } }
        : { type: 'text', text: echoed && listed ? MARKER : 'MCP_NOT_LOADED' };
      const message = { id: `msg_${observations.length}`, type: 'message', role: 'assistant', model: request.model, content: [content], stop_reason: selected ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
      if (!request.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      emit('message_start', { message: { ...message, content: [], stop_reason: null } });
      emit('content_block_start', { index: 0, content_block: selected ? { ...content, input: {} } : { type: 'text', text: '' } });
      emit('content_block_delta', { index: 0, delta: selected ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } : { type: 'text_delta', text: content.text } });
      emit('content_block_stop', { index: 0 });
      emit('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
      emit('message_stop', {});
      res.end();
    } catch (error) { fixtureErrors.push(error.message); res.writeHead(400); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { PATH: process.env.PATH, HOME: host, USERPROFILE: host, TERM: 'dumb', NO_PROXY: '127.0.0.1,localhost', CLAUDE_CONFIG_DIR: path.join(host, '.claude'), ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, filename), 'Native MCP directory evidence.\n');
    const manager = createMcpManager({ aiHomeDir: path.join(root, 'aih'), hostHomeDir: host });
    manager.add('aih-demo', { command: process.execPath, args: [path.resolve(__dirname, '../examples/mcp/aih-demo-server.js')] }, { provider: 'claude' });
    manager.enable('aih-demo', { provider: 'claude' });
    const steps = [];
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      if (stage === 'disabled') manager.disable('aih-demo', { provider: 'claude' });
      if (stage === 're-enabled') manager.enable('aih-demo', { provider: 'claude' });
      if (stage === 'removed') manager.remove('aih-demo', { provider: 'claude' });
      observations.length = 0;
      const { stdout } = await execute(binary, ['-p', 'Use the available AIH MCP tools.', '--model', 'claude-sonnet-4-5', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--max-turns', '5', '--allowedTools', 'mcp__aih-demo__aih_echo', 'mcp__aih-demo__aih_list_files'], { cwd: work, env, timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      const expected = ['enabled', 're-enabled'].includes(stage);
      const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch (_) { return []; } });
      const completed = events.filter(event => event.type === 'user').flatMap(event => event.message?.content || []).filter(block => block.type === 'tool_result' && !block.is_error);
      const echoEvent = completed.some(block => block.tool_use_id === 'echo-call' && JSON.stringify(block.content).includes(nonce));
      const filesEvent = completed.some(block => block.tool_use_id === 'files-call' && JSON.stringify(block.content).includes(filename));
      const final = events.findLast(event => event.type === 'result');
      assert.ok(final && !final.is_error, 'native final result missing');
      const answer = final.result?.trim();
      assert.deepEqual(fixtureErrors, []);
      assert.equal(observations.length, expected ? 4 : 1, 'native MCP roundtrip count');
      assert.equal(observations.some(row => row.echoAdvertised), expected, 'native MCP deferred echo availability');
      assert.equal(observations.some(row => row.filesAdvertised), expected, 'native MCP deferred file-list availability');
      assert.equal(observations.some(row => row.searched), expected, 'native ToolSearch result');
      assert.equal(observations.some(row => row.echoSchema), expected, 'native MCP echo schema');
      assert.equal(observations.some(row => row.filesSchema), expected, 'native MCP file-list schema');
      assert.equal(observations.some(row => row.echoed && row.listed), expected, 'both MCP results reached model');
      assert.equal(echoEvent, expected, 'native completed echo event');
      assert.equal(filesEvent, expected, 'native completed file-list event');
      assert.equal(answer, expected ? MARKER : 'MCP_NOT_LOADED', 'exact native final answer');
      steps.push({ stage, toolSchema: expected, deferredSearch: expected, echoExecuted: echoEvent, filesExecuted: filesEvent, resultsObserved: expected, requests: observations.length, answer, passed: true });
    }
    return { host: 'claude', resource: 'mcp', binary, version: (await execute(binary, ['--version'], { env, timeout: 5000 })).stdout.trim(), inference: 'local-deterministic-tool-fixture', toolExecutionVerified: true, steps, passed: true };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/claude-mcp-tool-loop-demo.js [native-cli-path]');
  else runClaudeMcpDemo(process.argv[2]).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { runClaudeMcpDemo };
