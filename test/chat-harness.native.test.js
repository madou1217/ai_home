'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { createChatRuntimeComposition } = require('../lib/server/chat-runtime-composition');
const { createAppServerClient } = require('../lib/server/codex-app-server-json-rpc-client');

// Explicit opt-in: runs the installed Harness against a local deterministic model,
// with an empty HOME and no real provider credentials or upstream requests.
for (const credentialKind of ['codex', 'codex-api-key', 'claude', 'agy']) test(`real Codex Harness owns ${credentialKind} history, resume, compaction and reload`, {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE, timeout: 60000
}, async (t) => {
  const provider = credentialKind === 'codex-api-key' ? 'codex' : credentialKind;
  const useGateway = credentialKind !== 'codex';
  const gatewayModel = provider === 'agy' ? 'gemini-2.5-flash' : 'claude-sonnet-4-5';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-chat-harness-native-'));
  const requests = [];
  let releaseReasoning;
  const reasoningGate = new Promise((resolve) => { releaseReasoning = resolve; });
  const gateway = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ url: req.url, body, accountRef: req.headers['x-account-ref'] });
    await respond(res, requests.length, reasoningGate);
  });
  await listen(gateway);
  const placeholder = http.createServer();
  await listen(placeholder);
  const port = placeholder.address().port;
  await new Promise((resolve) => placeholder.close(resolve));
  const baseEnv = { PATH: process.env.PATH, HOME: root, LANG: 'en_US.UTF-8', TMPDIR: os.tmpdir() };
  const chatGateway = { port: gateway.address().port, clientKey: 'local-probe', readModels: async () => [gatewayModel] };
  const readCredential = () => ({ provider, accountRef: 'acct_probe',
    env: credentialKind === 'codex-api-key' ? { OPENAI_API_KEY: 'local-probe' } : {} });
  const gatewayOptions = !useGateway ? null
    : require('../lib/server/chat-runtime/chat-harness-gateway').createChatGatewayOptions(
      { provider, executionAccountRef: 'acct_probe' },
      { aiHomeDir: root, env: baseEnv, chatGateway, readAccountCredentialRecord: readCredential }
    );
  const runtimeEnv = gatewayOptions ? gatewayOptions.buildProviderEnvImpl() : {
    ...baseEnv, CODEX_HOME: path.join(root, '.codex'), CODEX_SQLITE_HOME: path.join(root, '.codex')
  };
  const codexHome = runtimeEnv.CODEX_HOME;
  fs.mkdirSync(codexHome, { recursive: true });
  if (!gatewayOptions) fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'model_provider = "probe"', 'check_for_update_on_startup = false',
    '[model_providers.probe]', 'name = "Local Harness Probe"',
    `base_url = "http://127.0.0.1:${gateway.address().port}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false', ''
  ].join('\n'));
  const executable = process.env.AIH_TEST_CODEX_EXECUTABLE;
  const logPath = path.join(root, 'native.log');
  const startHarness = () => {
    const log = fs.openSync(logPath, 'a');
    try {
      return spawn(executable, ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
        // Bypass host CLI hooks so this test owns the native process it stops.
        cwd: root, env: { ...runtimeEnv, AIH_CODEX_APP_SERVER_PASSTHROUGH: '1' },
        stdio: ['ignore', log, log]
      });
    } finally {
      fs.closeSync(log);
    }
  };
  let child = startHarness();
  let service;
  const clients = [];
  t.after(async () => {
    releaseReasoning();
    if (service) service.close();
    clients.forEach((client) => client.destroy());
    await stopHarness(child);
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    if (process.env.AIH_TEST_KEEP_ARTIFACTS) console.log(`Harness probe artifacts: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/readyz`)).ok; } catch { return false; }
  });
  const rpc = [];
  const makeService = () => createChatRuntimeComposition({
    aiHomeDir: root, hostHomeDir: root, getProfileDir: () => root,
    env: baseEnv, chatGateway, readAccountCredentialRecord: readCredential,
    runtimeResolver: { resolve: (provider, context) => ({ provider,
      runtimeScope: context.runtimeScope, executablePath: executable, fingerprint: 'probe', generation: 1 }) },
    accountIdentityValidator: async ({ initializeResult }) => {
      assert.equal(fs.realpathSync(initializeResult.codexHome), fs.realpathSync(codexHome));
      return { verified: true, kind: 'api-key', assurance: 'execution-credential',
        runtimeHomeHash: require('node:crypto').createHash('sha256').update(codexHome).digest('hex'),
        executionAccountHash: require('node:crypto').createHash('sha256').update('acct_probe').digest('hex') };
    },
    codexClientFactory(options) {
      const client = createAppServerClient({ ...options, resolveEndpoint: () => `ws://127.0.0.1:${port}` });
      const request = client.request.bind(client);
      client.request = (method, params) => { rpc.push({ method, params }); return request(method, params); };
      const bind = client.bindTurn.bind(client);
      client.bindTurn = (id, handlers) => bind(id, { ...handlers, onNotification(message) {
        fs.appendFileSync(path.join(root, 'notifications.jsonl'), `${JSON.stringify(message)}\n`);
        handlers.onNotification(message);
      } });
      clients.push(client);
      return client;
    }
  });
  const { saveChatSession } = require('../lib/server/webui-chat-store');
  saveChatSession({ id: 'chat-old', provider, accountRef: 'acct_probe',
    title: 'Native import', messages: [{ role: 'user', content: 'Remember cobalt-42' },
      { role: 'assistant', content: 'Remembered cobalt-42' }] }, root);
  service = makeService();
  const session = await service.openChatSession({ provider, executionAccountRef: 'acct_probe', chatSessionId: 'chat-old' });
  if (provider === 'agy') {
    const catalog = await service.readComposerCatalog(session.sessionId);
    assert.equal(catalog.defaultModel, gatewayModel);
    assert.equal(catalog.models[0].defaultEffort, '');
  }
  await service.dispatchCommand(session.sessionId, {
    commandId: 'turn-1', type: 'turn.submit', payload: { content: 'What is the marker?' }
  });
  await waitFor(() => service.getSnapshot(session.sessionId).timeline.some((item) => (
    item.id === 'rs_probe_active' && item.status === 'running'
  )));
  const history = await clients.at(-1).request('thread/read', {
    threadId: service.getSnapshot(session.sessionId).runtimeBinding.nativeSessionId,
    includeTurns: true
  });
  const activeHistory = history.thread.turns.at(-1);
  assert.equal(activeHistory.status, 'inProgress');
  assert.ok(activeHistory.items.some((item) => item.id === 'rs_probe_done'));
  assert.equal(activeHistory.items.some((item) => item.id === 'rs_probe_active'), false);
  const { projectCodexSessionHistory } = require('../lib/server/chat-runtime/codex-session-history');
  const imported = projectCodexSessionHistory(history, { threadId: history.thread.id });
  service.store.importTimeline(session.sessionId, imported.events);
  const during = service.getSnapshot(session.sessionId);
  assert.equal(during.state, 'running');
  assert.equal(during.timeline.find((item) => item.id === 'rs_probe_done').status, 'completed');
  assert.equal(during.timeline.find((item) => item.id === 'rs_probe_active').status, 'running');
  releaseReasoning();
  await idle(service, session.sessionId);
  await submit(service, session.sessionId, 'turn-2', 'Repeat the marker');
  assert.match(JSON.stringify(requests[0].body.input), /cobalt-42/);
  assert.match(JSON.stringify(requests[1].body.input), /What is the marker/);
  const compact = await service.dispatchCommand(session.sessionId, {
    commandId: 'compact-1', type: 'slash.execute', payload: { name: 'compact' }
  });
  assert.equal(compact.result.state, 'running');
  await idle(service, session.sessionId);
  assert.ok(service.getSnapshot(session.sessionId).timeline.some((item) => (
    item.detail && ['contextCompaction', 'context_compacted'].includes(item.detail.code)
  )));
  const nativeId = service.getSnapshot(session.sessionId).runtimeBinding.nativeSessionId;
  service.close();
  clients.forEach((client) => client.destroy());
  const previousPid = child.pid;
  await stopHarness(child);
  child = startHarness();
  assert.notEqual(child.pid, previousPid);
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/readyz`)).ok; } catch { return false; }
  });
  service = makeService();
  const restored = await service.openChatSession({ provider, executionAccountRef: 'acct_probe', chatSessionId: session.sessionId });
  assert.equal(restored.runtimeBinding.nativeSessionId, nativeId);
  await submit(service, session.sessionId, 'turn-3', 'Continue after reload');
  assert.match(JSON.stringify(requests.at(-1).body.input), /cobalt-42/);
  assert.equal(rpc.filter((call) => call.method === 'thread/start').length, 1);
  assert.equal(rpc.filter((call) => call.method === 'thread/inject_items').length, 1);
  assert.equal(rpc.filter((call) => call.method === 'thread/compact/start').length, 1);
  assert.ok(rpc.filter((call) => call.method === 'thread/resume').length >= 3);
  if (useGateway) assert.ok(requests.every((request) => request.accountRef === 'acct_probe'
    && request.body.model === gatewayModel));
  console.log(JSON.stringify({ provider, credentialKind, nativeThreadId: nativeId, modelRequests: requests.length,
    threadStarts: 1, imports: 1, compactions: 1, restored: true, nativeProcessRestarted: true }));
});

async function stopHarness(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    // Bound teardown of this test-owned process before removing its home.
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

async function submit(service, sessionId, commandId, content) {
  await service.dispatchCommand(sessionId, { commandId, type: 'turn.submit', payload: { content } });
  await idle(service, sessionId);
}

async function idle(service, sessionId) {
  await service.waitForActorIdle(sessionId);
  const failures = service.readEvents(sessionId).events.filter((event) => event.type === 'turn.failed');
  assert.deepEqual(failures.map((event) => event.payload), []);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

async function waitFor(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Native Harness did not become ready');
}

async function respond(res, count, reasoningGate) {
  const id = `resp_probe_${count}`;
  const text = `cobalt-42 response ${count}`;
  const item = { id: `msg_probe_${count}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  const reasoningItems = count === 1 ? ['rs_probe_done', 'rs_probe_active'].map((itemId) => ({
    id: itemId, type: 'reasoning', summary: []
  })) : [];
  const response = { id, object: 'response', created_at: Math.floor(Date.now() / 1000),
    status: 'completed', output: [...reasoningItems, item],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  send('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  if (count === 1) {
    send('response.output_item.added', { output_index: 0, item: reasoningItems[0] });
    send('response.output_item.done', { output_index: 0, item: reasoningItems[0] });
    send('response.output_item.added', { output_index: 1, item: reasoningItems[1] });
    await reasoningGate;
    send('response.output_item.done', { output_index: 1, item: reasoningItems[1] });
  }
  const outputIndex = reasoningItems.length;
  send('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress', content: [] } });
  send('response.output_text.delta', { item_id: item.id, output_index: outputIndex, content_index: 0, delta: text });
  send('response.output_item.done', { output_index: outputIndex, item });
  send('response.completed', { response });
  res.end();
}
