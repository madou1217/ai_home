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

for (const mode of ['running', 'completed', 'stop']) test(`lost turn/start receipt recovers the accepted native turn (${mode})`, {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE, timeout: 40000
}, async (t) => {
  const f = await nativeFixture(t);
  let offline = false;
  let reconnect;
  const gate = new Promise((resolve) => { reconnect = resolve; });
  t.after(() => reconnect());
  const service = f.open({ loseStartReceipt: true, beforeConnect: () => offline ? gate : undefined });
  const session = await service.createSession({ provider: 'codex', executionAccountRef: 'tool-probe',
    projectPath: f.root, policy: { approvalMode: 'bypass' } });
  await service.dispatchCommand(session.sessionId, { commandId: 'execute-marker', type: 'turn.submit',
    payload: { content: 'Run the local tool probe once.' } });
  await waitFor(() => fs.existsSync(path.join(f.root, 'marker')));
  const before = service.getSnapshot(session.sessionId);
  assert.equal(before.activeTurn.nativeTurnId, undefined);
  assert.equal(before.timeline.some((i) => i.kind === 'shell'), false);
  offline = true;
  f.sockets[0].terminate();
  await new Promise((resolve) => f.sockets[0].once('close', resolve));
  const inspection = f.client();
  if (mode === 'completed') {
    fs.writeFileSync(path.join(f.root, 'release'), 'continue');
    await waitFor(async () => {
      const response = await inspection.request('thread/read', {
        threadId: before.runtimeBinding.nativeSessionId, includeTurns: true
      });
      return response.thread.turns.at(-1)?.status === 'completed';
    });
  }
  const stopping = mode === 'stop'
    ? service.dispatchCommand(session.sessionId, { commandId: 'stop-without-receipt', type: 'turn.interrupt', payload: {} })
    : null;
  if (stopping) await waitFor(() => service.getSnapshot(session.sessionId).activeTurn?.interruptRequested);
  reconnect();
  await waitFor(() => f.resumes.length === 1);
  if (mode === 'running') {
    const attached = service.getSnapshot(session.sessionId);
    assert.equal(attached.activeTurn.runId, before.activeTurn.runId);
    assert.ok(attached.activeTurn.nativeTurnId, 'recovered native anchor must be persisted');
    assert.equal(attached.timeline.find((i) => i.kind === 'shell').status, 'running');
    fs.writeFileSync(path.join(f.root, 'release'), 'continue');
  }
  if (stopping) await stopping;
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
  const completed = service.getSnapshot(session.sessionId);
  assert.equal(completed.failedTurn, undefined);
  if (mode === 'stop') {
    assert.equal(completed.policy.queueControl.paused, true);
    assert.notEqual(completed.timeline.find((i) => i.kind === 'shell').status, 'running');
    const response = await inspection.request('thread/read', {
      threadId: before.runtimeBinding.nativeSessionId, includeTurns: true
    });
    assert.equal(response.thread.turns.at(-1)?.status, 'interrupted');
  } else {
    assert.equal(completed.timeline.find((i) => i.kind === 'shell').status, 'completed');
    assert.equal(completed.timeline.find((i) => i.content === 'TOOL_PROBE_DONE').turnId, before.activeTurn.turnId);
  }
  assert.equal(fs.readFileSync(path.join(f.root, 'marker'), 'utf8'), 'executed\n');
  assert.equal(f.requests.length, mode === 'stop' ? 1 : 2);
});

test('unconfirmed turn/start with no native anchor remains non-retryable after reload', {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE, timeout: 40000
}, async (t) => {
  const f = await nativeFixture(t);
  let service = f.open({ dropStartRequest: true });
  const session = await service.createSession({ provider: 'codex', executionAccountRef: 'tool-probe',
    projectPath: f.root, policy: { approvalMode: 'bypass' } });
  const submitted = await service.dispatchCommand(session.sessionId, { commandId: 'uncertain', type: 'turn.submit',
    payload: { content: 'Run the local tool probe once.' } });
  // Empty native threads may reject resume. The existing transport policy makes
  // eight attempts (18 seconds of backoff) before declaring recovery exhausted.
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle', 30000);
  const failure = service.getSnapshot(session.sessionId).failedTurn;
  assert.equal(failure.outcomeUnknown, true);
  assert.equal(failure.retryable, false);
  assert.equal(failure.error.code, 'codex_turn_start_outcome_unknown');
  service.close();
  f.disconnect();
  service = f.open();
  await service.waitForRecovery();
  assert.deepEqual(service.getSnapshot(session.sessionId).failedTurn, failure);
  await assert.rejects(service.dispatchCommand(session.sessionId, { commandId: 'retry-unknown', type: 'turn.retry',
    payload: { sourceTurnId: submitted.result.turnId } }), /chat_retry_not_available/);
  assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'marker')), false);
});

test('automatic WebSocket reconnect imports offline completion without restarting AIH or the tool', {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE, timeout: 40000
}, async (t) => {
  const f = await nativeFixture(t);
  let offline = false;
  let reconnect;
  const gate = new Promise((resolve) => { reconnect = resolve; });
  t.after(() => reconnect());
  const service = f.open({ beforeConnect: () => offline ? gate : undefined });
  const session = await service.createSession({ provider: 'codex', executionAccountRef: 'tool-probe',
    projectPath: f.root, policy: { approvalMode: 'bypass' } });
  await service.dispatchCommand(session.sessionId, { commandId: 'execute-marker', type: 'turn.submit',
    payload: { content: 'Run the local tool probe once.' } });
  await waitFor(() => fs.existsSync(path.join(f.root, 'marker')));
  await waitFor(() => service.getSnapshot(session.sessionId).timeline.some((i) => i.kind === 'shell'));
  const before = service.getSnapshot(session.sessionId);
  offline = true;
  f.sockets[0].terminate();
  await new Promise((resolve) => f.sockets[0].once('close', resolve));
  fs.writeFileSync(path.join(f.root, 'release'), 'continue');
  const inspection = f.client();
  await waitFor(async () => {
    const response = await inspection.request('thread/read', {
      threadId: before.runtimeBinding.nativeSessionId, includeTurns: true
    });
    return response.thread.turns.at(-1)?.status === 'completed';
  });
  reconnect();
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
  const recovered = service.getSnapshot(session.sessionId);
  assert.equal(recovered.timeline.filter((i) => i.kind === 'shell').length, 1);
  assert.equal(recovered.timeline.find((i) => i.kind === 'shell').status, 'completed');
  const answer = recovered.timeline.find((i) => i.content === 'TOOL_PROBE_DONE');
  assert.equal(answer.turnId, before.activeTurn.turnId);
  assert.equal(answer.detail.metrics.ttftMs, undefined);
  assert.equal(fs.readFileSync(path.join(f.root, 'marker'), 'utf8'), 'executed\n');
  assert.equal(f.requests.length, 2);
});

test('stop during WebSocket reconnection cancels the original running tool and preserves queued input', {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE, timeout: 40000
}, async (t) => {
  const f = await nativeFixture(t);
  let offline = false;
  let reconnect;
  const gate = new Promise((resolve) => { reconnect = resolve; });
  t.after(() => reconnect());
  const service = f.open({ beforeConnect: () => offline ? gate : undefined });
  const session = await service.createSession({ provider: 'codex', executionAccountRef: 'tool-probe',
    projectPath: f.root, policy: { approvalMode: 'bypass' } });
  await service.dispatchCommand(session.sessionId, { commandId: 'execute-marker', type: 'turn.submit',
    payload: { content: 'Run the local tool probe once.' } });
  await waitFor(() => fs.existsSync(path.join(f.root, 'marker')));
  await waitFor(() => service.getSnapshot(session.sessionId).timeline.some((i) => i.kind === 'shell'));
  const before = service.getSnapshot(session.sessionId);
  offline = true;
  f.sockets[0].terminate();
  await new Promise((resolve) => f.sockets[0].once('close', resolve));
  const queued = await service.dispatchCommand(session.sessionId, { commandId: 'pending-followup', type: 'queue.add',
    payload: { content: 'Keep this input after cancellation.', policy: 'after_turn' } });
  const stopRequest = service.dispatchCommand(session.sessionId, { commandId: 'stop-tool', type: 'turn.interrupt', payload: {} });
  await waitFor(() => service.getSnapshot(session.sessionId).activeTurn?.interruptRequested);
  reconnect();
  await stopRequest;
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
  const stopped = service.getSnapshot(session.sessionId);
  assert.equal(stopped.policy.queueControl.paused, true);
  assert.equal(service.store.queue.get(queued.result.queueId).status, 'queued');
  assert.equal(stopped.timeline.filter((i) => i.kind === 'shell').length, 1);
  assert.notEqual(stopped.timeline.find((i) => i.kind === 'shell').status, 'running');
  assert.equal(fs.readFileSync(path.join(f.root, 'marker'), 'utf8'), 'executed\n');
  assert.equal(f.requests.length, 1);
  const inspection = f.client();
  const history = await inspection.request('thread/read', {
    threadId: before.runtimeBinding.nativeSessionId, includeTurns: true
  });
  assert.equal(history.thread.turns.at(-1).id, before.activeTurn.nativeTurnId);
  assert.equal(history.thread.turns.at(-1).status, 'interrupted');
});

test('automatic reconnect keeps a running tool bound until its single result arrives', {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE, timeout: 40000
}, async (t) => {
  const f = await nativeFixture(t);
  const service = f.open();
  const session = await service.createSession({ provider: 'codex', executionAccountRef: 'tool-probe',
    projectPath: f.root, policy: { approvalMode: 'bypass' } });
  await service.dispatchCommand(session.sessionId, { commandId: 'execute-marker', type: 'turn.submit',
    payload: { content: 'Run the local tool probe once.' } });
  await waitFor(() => fs.existsSync(path.join(f.root, 'marker')));
  await waitFor(() => service.getSnapshot(session.sessionId).timeline.some((i) => i.kind === 'shell'));
  const before = service.getSnapshot(session.sessionId);
  f.sockets[0].terminate();
  await waitFor(() => f.resumes.length === 1);
  const resumed = service.getSnapshot(session.sessionId);
  assert.equal(resumed.activeTurn.nativeTurnId, before.activeTurn.nativeTurnId);
  assert.equal(resumed.state, 'running');
  fs.writeFileSync(path.join(f.root, 'release'), 'continue');
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
  const completed = service.getSnapshot(session.sessionId);
  assert.equal(completed.timeline.filter((i) => i.kind === 'shell').length, 1);
  assert.equal(completed.timeline.find((i) => i.kind === 'shell').status, 'completed');
  assert.equal(completed.timeline.filter((i) => i.content === 'TOOL_PROBE_DONE').length, 1);
  assert.equal(fs.readFileSync(path.join(f.root, 'marker'), 'utf8'), 'executed\n');
  assert.equal(f.requests.length, 2);
});

// Actual native tool execution against a deterministic loopback model. All files,
// HOME and credentials belong to this test; opt-in matches the Chat native suite.
test('native recovery imports tool results and the answer completed while AIH was offline', {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE, timeout: 40000
}, async (t) => {
  const f = await nativeFixture(t);
  let service = f.open();
  const session = await service.createSession({ provider: 'codex', executionAccountRef: 'tool-probe',
    projectPath: f.root, policy: { approvalMode: 'bypass' } });
  await service.dispatchCommand(session.sessionId, { commandId: 'execute-marker', type: 'turn.submit',
    payload: { content: 'Run the local tool probe once.' } });
  await waitFor(() => fs.existsSync(path.join(f.root, 'marker')));
  await waitFor(() => service.getSnapshot(session.sessionId).timeline.some((i) => i.kind === 'shell'));
  const before = service.getSnapshot(session.sessionId);
  assert.equal(before.timeline.find((i) => i.kind === 'shell').status, 'running');
  assert.ok(before.activeTurn.nativeTurnId);
  service.close();
  f.disconnect();
  fs.writeFileSync(path.join(f.root, 'release'), 'continue');
  await waitFor(() => f.requests.length === 2);
  const inspection = f.client();
  await waitFor(async () => {
    const history = await inspection.request('thread/read', {
      threadId: before.runtimeBinding.nativeSessionId, includeTurns: true
    });
    return history.thread.turns.at(-1)?.status === 'completed';
  });
  service = f.open();
  await service.waitForRecovery();
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
  const recovered = service.getSnapshot(session.sessionId);
  fs.writeFileSync(path.join(f.root, 'recovered.json'), JSON.stringify(recovered, null, 2));
  assert.equal(fs.readFileSync(path.join(f.root, 'marker'), 'utf8'), 'executed\n');
  assert.equal(f.requests.length, 2, 'recovery must not start another model request');
  assert.equal(recovered.timeline.find((i) => i.kind === 'shell').status, 'completed');
  assert.equal(recovered.timeline.find((i) => i.kind === 'shell').detail.exitCode, 0);
  const answer = recovered.timeline.find((i) => i.kind === 'message' && i.content === 'TOOL_PROBE_DONE');
  assert.equal(answer.turnId, before.activeTurn.turnId);
  assert.ok(answer.detail.metrics.durationMs >= 0);
  assert.equal(answer.detail.metrics.ttftMs, undefined, 'offline history is not observed first-token timing');
  assert.ok(f.requests[1].input.some((i) => ['function_call_output', 'custom_tool_call_output'].includes(i.type)
    && i.call_id === 'probe-tool'));
});

test('killing the native executor after the side effect never replays the command on recovery', {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE, timeout: 40000
}, async (t) => {
  const f = await nativeFixture(t);
  let service = f.open();
  const session = await service.createSession({ provider: 'codex', executionAccountRef: 'tool-probe',
    projectPath: f.root, policy: { approvalMode: 'bypass' } });
  await service.dispatchCommand(session.sessionId, { commandId: 'execute-marker', type: 'turn.submit',
    payload: { content: 'Run the local tool probe once.' } });
  await waitFor(() => fs.existsSync(path.join(f.root, 'marker')));
  await waitFor(() => service.getSnapshot(session.sessionId).timeline.some((i) => i.kind === 'shell'));
  service.close();
  f.disconnect();
  await f.restartNative();
  service = f.open();
  await service.waitForRecovery();
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
  const recovered = service.getSnapshot(session.sessionId);
  fs.writeFileSync(path.join(f.root, 'recovered.json'), JSON.stringify(recovered, null, 2));
  assert.equal(fs.readFileSync(path.join(f.root, 'marker'), 'utf8'), 'executed\n');
  assert.equal(f.requests.length, 1);
  assert.equal(recovered.timeline.find((i) => i.kind === 'shell').status, 'unknown');
  assert.equal(recovered.timeline.find((i) => i.kind === 'shell').detail.exitCode, undefined);
  assert.equal(recovered.policy.queueControl.paused, true);
});

test('reattaching a still-running native tool preserves its identity and consumes its later result once', {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE, timeout: 40000
}, async (t) => {
  const f = await nativeFixture(t);
  let service = f.open();
  const session = await service.createSession({ provider: 'codex', executionAccountRef: 'tool-probe',
    projectPath: f.root, policy: { approvalMode: 'bypass' } });
  await service.dispatchCommand(session.sessionId, { commandId: 'execute-marker', type: 'turn.submit',
    payload: { content: 'Run the local tool probe once.' } });
  await waitFor(() => service.getSnapshot(session.sessionId).timeline.some((i) => i.kind === 'shell'));
  await waitFor(() => fs.existsSync(path.join(f.root, 'marker')));
  const before = service.getSnapshot(session.sessionId);
  service.close();
  f.disconnect();
  service = f.open();
  await service.waitForRecovery();
  const attached = service.getSnapshot(session.sessionId);
  assert.equal(attached.state, 'running');
  assert.equal(attached.activeTurn.nativeTurnId, before.activeTurn.nativeTurnId);
  assert.equal(attached.timeline.find((i) => i.kind === 'shell').status, 'running');
  fs.writeFileSync(path.join(f.root, 'release'), 'continue');
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
  const completed = service.getSnapshot(session.sessionId);
  assert.equal(completed.timeline.filter((i) => i.kind === 'shell').length, 1);
  assert.equal(completed.timeline.find((i) => i.kind === 'shell').status, 'completed');
  assert.equal(fs.readFileSync(path.join(f.root, 'marker'), 'utf8'), 'executed\n');
  assert.equal(f.requests.length, 2);
});

async function nativeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-tool-recovery-'));
  const requests = [];
  const clients = [];
  const sockets = [];
  const resumes = [];
  const services = [];
  const gateway = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    fs.writeFileSync(path.join(root, 'requests.json'), JSON.stringify(requests, null, 2));
    if (requests.length === 1) {
      const available = body.tools || body.input.filter((item) => item.type === 'additional_tools').flatMap((item) => item.tools);
      const names = available.map((tool) => tool.name);
      const cmd = "printf 'executed\\n' >> marker; while [ ! -f release ]; do sleep 0.05; done; printf TOOL_OUTPUT";
      const name = names.includes('exec_command') ? 'exec_command' : names.includes('shell_command') ? 'shell_command' : 'shell';
      const args = name === 'exec_command' ? { cmd, yield_time_ms: 10000, max_output_tokens: 200 }
        : name === 'shell_command' ? { command: cmd, timeout_ms: 10000 }
          : { command: ['/bin/sh', '-c', cmd], timeout_ms: 10000 };
      const composed = available.some((tool) => tool.name === 'functions' && tool.tools?.some((nested) => nested.name === 'exec'));
      respond(res, [composed
        ? { type: 'custom_tool_call', id: 'fc-probe', call_id: 'probe-tool', name: 'exec', namespace: 'functions',
          input: `text(await tools.exec_command(${JSON.stringify({ cmd, yield_time_ms: 10000, max_output_tokens: 200 })}));` }
        : { type: 'function_call', id: 'fc-probe', call_id: 'probe-tool', name, arguments: JSON.stringify(args) }]);
    } else respond(res, [{ type: 'message', id: 'msg-final', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'TOOL_PROBE_DONE', annotations: [] }] }]);
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const portProbe = http.createServer();
  await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const codexHome = path.join(root, '.codex');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    'model_provider = "probe"', 'check_for_update_on_startup = false',
    '[model_providers.probe]', 'name = "Local Tool Probe"',
    `base_url = "http://127.0.0.1:${gateway.address().port}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false', ''
  ].join('\n'));
  const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: codexHome, CODEX_SQLITE_HOME: codexHome,
    LANG: 'en_US.UTF-8', TMPDIR: os.tmpdir(), AIH_CODEX_APP_SERVER_PASSTHROUGH: '1' };
  const executable = process.env.AIH_TEST_CODEX_EXECUTABLE;
  const start = () => {
    const log = fs.openSync(path.join(root, 'native.log'), 'a');
    try { return spawn(executable, ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
      cwd: root, env, stdio: ['ignore', log, log]
    }); } finally { fs.closeSync(log); }
  };
  let child = start();
  t.after(async () => {
    fs.writeFileSync(path.join(root, 'release'), 'cleanup');
    services.forEach((service) => service.close());
    clients.forEach((client) => client.destroy());
    await stop(child);
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    if (process.env.AIH_TEST_KEEP_ARTIFACTS) console.log(`Native tool artifacts: ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/readyz`)).ok; } catch { return false; }
  });
  const client = (options = {}) => {
    const instance = createAppServerClient({ ...options,
      wsImpl: class extends require('ws') {
        constructor(endpoint) { super(endpoint); sockets.push(this); }
        send(data, ...args) {
          if (JSON.parse(String(data)).method === 'turn/start') {
            if (options.dropStartRequest) { this.terminate(); return; }
            if (options.loseStartReceipt) this.loseReceipt = true;
          }
          return super.send(data, ...args);
        }
        emit(event, ...args) {
          if (event === 'message' && this.loseReceipt) return true;
          return super.emit(event, ...args);
        }
      },
      resolveEndpoint: async () => {
        if (options.beforeConnect) await options.beforeConnect();
        return `ws://127.0.0.1:${port}`;
      } });
    const bind = instance.bindTurn.bind(instance);
    instance.bindTurn = (id, handlers) => bind(id, { ...handlers, onNotification(message) {
      fs.appendFileSync(path.join(root, 'notifications.jsonl'), `${JSON.stringify(message)}\n`);
      handlers.onNotification(message);
    }, async onReconnectResume(response) {
      await handlers.onReconnectResume(response);
      resumes.push(response);
    } });
    clients.push(instance);
    return instance;
  };
  return { root, requests, client, sockets, resumes, disconnect: () => clients.forEach((c) => c.destroy()),
    async restartNative() {
      await stop(child, 'SIGKILL');
      child = start();
      await waitFor(async () => {
        try { return (await fetch(`http://127.0.0.1:${port}/readyz`)).ok; } catch { return false; }
      });
    },
    open(clientOverrides = {}) {
      const service = createChatRuntimeComposition({ aiHomeDir: root, hostHomeDir: root,
        getProfileDir: () => root, env,
        runtimeResolver: { resolve: () => ({ provider: 'codex', runtimeScope: 'tool-probe',
          executablePath: executable, fingerprint: 'native-tool-probe', generation: 1 }) },
        accountIdentityValidator: async ({ initializeResult }) => {
          assert.equal(fs.realpathSync(initializeResult.codexHome), fs.realpathSync(codexHome));
          return { verified: true, kind: 'api-key', assurance: 'execution-credential',
            runtimeHomeHash: require('node:crypto').createHash('sha256').update(codexHome).digest('hex'),
            executionAccountHash: require('node:crypto').createHash('sha256').update('tool-probe').digest('hex') };
        }, codexClientFactory: (options) => client({ ...options, ...clientOverrides }) });
      services.push(service);
      return service;
    } };
}

async function stop(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill(signal);
  });
}

function respond(res, output) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  send('response.created', { response: { id: 'resp-probe', status: 'in_progress', output: [] } });
  for (const [index, item] of output.entries()) {
    send('response.output_item.added', { output_index: index, item });
    send('response.output_item.done', { output_index: index, item });
  }
  send('response.completed', { response: { id: 'resp-probe', status: 'completed', output,
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } });
  res.end();
}

async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Native tool probe timed out');
}
