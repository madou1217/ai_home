'use strict';

// Opt-in native-client smoke. All model traffic is served by loopback fixtures;
// the child has a fresh HOME/CODEX_HOME and edits only one disposable test file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { handleCodexResponsesWebSocket } = require('../lib/server/codex-responses-websocket');
const { handleCodexChatCompletions } = require('../lib/server/codex-adapter');
const { chooseServerAccount, markProxyAccountFailure, markProxyAccountSuccess } = require('../lib/server/router');

const enabled = process.env.AIH_NATIVE_CODEX_QUOTA_SMOKE === '1';
const codexCli = path.resolve(__dirname, '../node_modules/@openai/codex/bin/codex.js');
const nativeBinary = process.env.AIH_NATIVE_CODEX_BINARY;
const goBinary = process.env.AIH_CODEX_HTTP_GO_BINARY;

for (const failure of goBinary ? ['quota', 'capacity'] : ['quota']) {
  test(`native Codex executes a tool once across a pooled ${failure} failure (${goBinary ? 'Go' : 'Node'})`, {
    skip: !enabled || !fs.existsSync(nativeBinary || codexCli), timeout: 45000
  }, t => runPooledFailure(t, failure));
}

async function runPooledFailure(t, failure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-quota-native-'));
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true }); fs.mkdirSync(workspace);
  const countFile = path.join(workspace, 'executions.txt');
  const sockets = new Set(), servers = [], requests = [], transports = [];
  const wss = new WebSocket.Server({ noServer: true });
  let child, output = '', errors = '', tools = [], primaryKey = '';
  t.after(async () => {
    child?.kill('SIGTERM');
    for (const socket of sockets) socket.destroy();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function listen(server) {
    servers.push(server);
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}/v1`;
  }
  const response = (id, items) => ({ id, object: 'response', created_at: 1700000000,
    model: 'gpt-5.4', status: 'completed', output: items,
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } });
  function events(payload, credential, transport) {
    if (payload.generate === false) return [{ type: 'response.completed', response: response('resp_warmup', []) }];
    primaryKey ||= credential;
    const ref = credential === primaryKey ? 'first' : 'second';
    requests.push({ ref, payload });
    transports.push(transport);
    tools = (payload.tools || []).map(tool => tool.name);
    if (requests.length === 1) {
      const name = ['exec_command', 'shell_command', 'shell'].find(item => tools.includes(item));
      assert.ok(name, 'native shell tool unavailable: ' + tools.join(','));
      const command = `printf 'once\\n' >> '${countFile.replace(/'/g, "'\\''")}'`;
      const args = name === 'exec_command' ? { cmd: command, yield_time_ms: 1000, max_output_tokens: 64 }
        : name === 'shell_command' ? { command, workdir: workspace, timeout_ms: 1000 }
          : { command: ['/bin/sh', '-c', command], workdir: workspace, timeout_ms: 1000 };
      const item = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name, arguments: JSON.stringify(args) };
      return [
        { type: 'response.created', response: { ...response('resp_tool', []), status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments },
        { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: response('resp_tool', [item]) }
      ];
    }
    if (ref === 'first') return [
      { type: 'response.created', response: { ...response('resp_rejected', []), status: 'in_progress' } },
      { type: 'response.failed', response: { ...response('resp_rejected', []), status: 'failed',
        error: failure === 'capacity'
          ? { code: 'model_at_capacity', message: 'Selected model is at capacity. Please try a different model.' }
          : { code: 'usage_limit_reached', message: 'Synthetic local quota rejection', resets_in_seconds: 300 } } }
    ];
    const item = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'quota-failover-finished', annotations: [] }] };
    return [
      { type: 'response.created', response: { ...response('resp_final', []), status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'quota-failover-finished' },
      { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'quota-failover-finished' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: response('resp_final', [item]) }
    ];
  }
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[{"id":"gpt-5.4","object":"model"}]}');
      return;
    }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events(payload, req.headers.authorization, 'http').map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  upstream.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
    ws.on('message', data => {
      try { for (const event of events(JSON.parse(data), req.headers.authorization, 'ws')) ws.send(JSON.stringify(event)); }
      catch (error) { errors += error.message; ws.close(); }
    });
  }));
  const base = await listen(upstream);
  const state = { accounts: { codex: ['first', 'second'].map(ref => ({ accountRef: ref,
    accessToken: `fixture-${ref}`, openaiBaseUrl: base, apiKeyMode: true })) },
    cursors: {}, metrics: { totalFailures: 0, totalSuccess: 0, totalTimeouts: 0 } };
  const options = { codexBaseUrl: base, maxAttempts: 3, upstreamTimeoutMs: 5000, logRequests: false };
  const gateway = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[],"data":[]}'); return; }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const requestJson = JSON.parse(Buffer.concat(chunks));
      await handleCodexChatCompletions({ req, res, requestJson, state, options,
        requestMeta: { clientProtocol: 'openai_responses', sessionKey: 'native-fixture' },
        routeKey: 'POST /v1/responses', requestStartedAt: Date.now(), cooldownMs: 1000,
        deps: { chooseServerAccount, markProxyAccountFailure, markProxyAccountSuccess,
          fetchWithTimeout: (url, init) => fetch(url, init), pushMetricError() {}, appendProxyRequestLog() {},
          writeJson: (target, status, body) => { target.writeHead(status, { 'content-type': 'application/json' }); target.end(JSON.stringify(body)); } }
      });
    } catch (error) { errors += error.message; res.destroy(); }
  });
  gateway.on('upgrade', (req, socket, head) => {
    handleCodexResponsesWebSocket({ req, socket, head, state, options }, {
      chooseAccount: chooseServerAccount, isLoopbackUrl: () => false,
      markProxyAccountFailure, markProxyAccountSuccess
    }).catch(error => { errors += error.message; socket.destroy(); });
  });
  let gatewayUrl = await listen(gateway);
  let clientKey = 'local-fixture-key';
  if (goBinary) {
    const { startGoGateway } = require('./helpers/codex-http-go-fixture');
    const go = await startGoGateway(t, base, 'gpt-5.4', { binary: goBinary });
    const secondRef = await go.register('synthetic-second-key');
    let secondReady = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const models = await fetch(`${go.base}/v1/management/accounts/${secondRef}/models`, {
        headers: { authorization: `Bearer ${go.managementKey}` }
      });
      if (models.ok && (await models.text()).includes('"model_id":"gpt-5.4"')) { secondReady = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(secondReady, 'second Go account catalog was not published');
    gatewayUrl = go.base + '/v1';
    clientKey = go.clientKey;
  }
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "fixture"\napproval_policy = "never"\n[features]\nresponses_websockets_v2 = true\n[model_providers.fixture]\nname = "Local fixture"\nbase_url = "${gatewayUrl}"\nwire_api = "responses"\nenv_key = "AIH_TEST_KEY"\nsupports_websockets = true\n`);
  const cliArgs = ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--json',
    '-c', 'features.code_mode=false',
    'In this disposable workspace append exactly one line once to executions.txt using a shell command, then report finished.'];
  child = spawn(nativeBinary || process.execPath, nativeBinary ? cliArgs : [codexCli, ...cliArgs], {
    cwd: workspace, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
      AIH_TEST_KEY: clientKey, NO_PROXY: 'localhost,127.0.0.1', TERM: 'dumb' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  clearTimeout(timer);
  assert.equal(code, 0, errors.slice(-3000) + '\n' + output.slice(-3000));
  assert.match(output, /quota-failover-finished/);
  assert.deepEqual(requests.map(x => x.ref), ['first', 'first', 'second']);
  assert.equal(fs.readFileSync(countFile, 'utf8'), 'once\n');
  assert.ok(requests[2].payload.input.some(item => item.type === 'function_call_output' && item.call_id === 'call_fixture'));
  if (goBinary) assert.deepEqual(transports, ['ws', 'ws', 'ws'], 'native client fell back to HTTP');
  t.diagnostic(JSON.stringify({ transport: transports, attempts: requests.map(x => x.ref), toolExecutions: 1 }));
}
