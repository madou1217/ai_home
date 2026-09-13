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
const { codexForkSource, findCodexForkReceipt, readCodexInjectionReceipt } = require('../lib/server/chat-runtime/codex-fork-receipt');
const { prepareNativeBranch } = require('../lib/server/chat-runtime/native-branch-operation');
const { CodexBranchOperationPort } = require('../lib/server/chat-runtime/codex-branch-operation-port');

for (const mode of ['running', 'completed', 'stop']) test(`lost turn/start receipt recovers the accepted native turn (${mode})`, {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE, timeout: 40000
}, async (t) => {
  const f = await nativeFixture(t);
  let offline = false;
  let reconnect;
  const gate = new Promise((resolve) => { reconnect = resolve; });
  t.after(() => reconnect());
  const service = f.open({ loseStartReceipt: true, beforeConnect: () => offline ? gate : undefined,
    resumeInitialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'summary' } });
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
  assert.ok(f.resumes[0].initialTurnsPage, 'lost receipt recovery uses a real paginated resume');
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

for (const historyView of ['legacy', 'paged-summary']) test(`automatic WebSocket reconnect imports offline completion (${historyView})`, {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE, timeout: 40000
}, async (t) => {
  const f = await nativeFixture(t);
  let offline = false;
  let reconnect;
  const gate = new Promise((resolve) => { reconnect = resolve; });
  t.after(() => reconnect());
  const service = f.open({ beforeConnect: () => offline ? gate : undefined,
    ...(historyView === 'paged-summary' ? { resumeInitialTurnsPage: {
      limit: 1, sortDirection: 'desc', itemsView: 'summary'
    } } : {}) });
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
  if (historyView === 'paged-summary') {
    const response = f.resumes.at(-1);
    assert.ok(response.initialTurnsPage, 'native app-server must actually return the requested page');
    assert.equal(response.initialTurnsPage.data[0].itemsView, 'summary');
    assert.equal(response.initialTurnsPage.data[0].items.some((item) => item.type === 'commandExecution'), false);
    assert.ok(recovered.timeline.find((i) => i.kind === 'shell').detail.output.includes('TOOL_OUTPUT'));
  }
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
  assert.equal(service.store.store.nativeResponseItems.coverage(session.sessionId,
    before.runtimeBinding.nativeSessionId, before.activeTurn.nativeTurnId), 'incomplete');
  fs.writeFileSync(path.join(f.root, 'release'), 'continue');
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
  const completed = service.getSnapshot(session.sessionId);
  assert.equal(completed.timeline.filter((i) => i.kind === 'shell').length, 1);
  assert.equal(completed.timeline.find((i) => i.kind === 'shell').status, 'completed');
  assert.equal(completed.timeline.filter((i) => i.content === 'TOOL_PROBE_DONE').length, 1);
  assert.equal(service.store.store.nativeResponseItems.coverage(session.sessionId,
    before.runtimeBinding.nativeSessionId, before.activeTurn.nativeTurnId), 'incomplete');
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

test('native parallel tools finish out of order but return calls and outputs in model order', {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE, timeout: 40000
}, async (t) => {
  const f = await nativeFixture(t, { parallelTools: true });
  const service = f.open();
  const session = await service.createSession({ provider: 'codex', executionAccountRef: 'tool-probe',
    projectPath: f.root, policy: { approvalMode: 'bypass' } });
  await service.dispatchCommand(session.sessionId, { commandId: 'parallel-tools', type: 'turn.submit',
    payload: { content: 'Run both independent probes.', model: 'gpt-5.5' } });
  await waitFor(() => fs.existsSync(path.join(f.root, 'parallel-b-finished')));
  assert.equal(fs.existsSync(path.join(f.root, 'parallel-a-finished')), false,
    'the second tool must finish while the first tool is still blocked');
  fs.writeFileSync(path.join(f.root, 'release'), 'continue');
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');

  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].parallel_tool_calls, true);
  assert.deepEqual(toolHistoryOrder(f.requests[1].input), [
    'call:parallel-a',
    'call:parallel-b',
    'output:parallel-a',
    'output:parallel-b'
  ]);
  const shellItems = service.getSnapshot(session.sessionId).timeline.filter((item) => item.kind === 'shell');
  assert.equal(shellItems.length, 2);
  assert.match(shellItems[0].detail.output, /A_OUTPUT/);
  assert.match(shellItems[1].detail.output, /B_OUTPUT/);
});

for (const historyMode of ['legacy', 'paginated'])
for (const receiptMode of ['received', 'lost', 'restart']) test(`native Work fork preserves the exact terminal prefix without replaying tools (${historyMode}, ${receiptMode})`, {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE, timeout: 40000
}, async (t) => {
  const rawReasoning = { type: 'reasoning', id: 'rs-work-fork',
    encrypted_content: 'opaque-work-fork-reasoning', summary: [{ type: 'summary_text', text: 'Run the marker once.' }] };
  const f = await nativeFixture(t, { modelOutput(body, count) {
    if (count === 1) {
      return [rawReasoning, commandToolCall((body.tools || []).map((tool) => tool.name),
        'fc-work-fork', 'work-fork-tool', "printf 'executed\\n' >> marker; printf FORK_TOOL_OUTPUT")];
    }
    return [{ type: 'message', id: `msg-work-fork-${count}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: `FORK_ANSWER_${count}`, annotations: [] }] }];
  } });
  const service = f.open({ startHistoryMode: historyMode });
  const session = await service.createSession({ provider: 'codex', executionAccountRef: 'tool-probe',
    projectPath: f.root, policy: { approvalMode: 'bypass' } });
  await service.dispatchCommand(session.sessionId, { commandId: 'work-fork-first', type: 'turn.submit',
    payload: { content: 'SOURCE_KEEP_FIRST', model: 'gpt-5.5' } });
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
  assert.equal(fs.readFileSync(path.join(f.root, 'marker'), 'utf8'), 'executed\n');
  const sourceId = service.getSnapshot(session.sessionId).runtimeBinding.nativeSessionId;
  const { readCodexHistoryResponse } = require('../lib/server/chat-runtime/codex-session-history');
  let client = f.client({ loseForkReceipt: receiptMode !== 'received' });
  const first = (await readCodexHistoryResponse(client, sourceId)).thread.turns[0];
  assert.equal(first.status, 'completed');
  // Legacy typed history omits this exec tool and replaces message IDs; the
  // next model request below is the authority for preserved raw history.
  if (historyMode === 'paginated') assert.ok(first.items.some((item) => item.type === 'commandExecution'));
  const originalReasoning = f.requests[1].input.find((item) => item.type === 'reasoning');
  const privateTurn = service.store.store.nativeResponseItems.readTurn(session.sessionId, sourceId, first.id);
  assert.equal(service.store.store.nativeResponseItems.coverage(session.sessionId, sourceId, first.id), 'complete');
  assert.ok(privateTurn.some((item) => item.type === 'function_call' && item.call_id === 'work-fork-tool'));
  assert.ok(privateTurn.some((item) => item.type === 'function_call_output' && item.call_id === 'work-fork-tool'));
  assert.equal(privateTurn.find((item) => item.type === 'reasoning').encrypted_content, rawReasoning.encrypted_content);
  assert.doesNotMatch(JSON.stringify(service.getSnapshot(session.sessionId)), /opaque-work-fork-reasoning/);
  await service.dispatchCommand(session.sessionId, { commandId: 'work-fork-later', type: 'turn.submit',
    payload: { content: 'SOURCE_EXCLUDE_LATER', model: 'gpt-5.5' } });
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
  const source = await readCodexHistoryResponse(client, sourceId);
  const metadata = await client.request('thread/read', { threadId: sourceId });
  const sourceBytes = fs.readFileSync(metadata.thread.path);
  const requestsBeforeFork = f.requests.length;
  const forks = [];
  for (const boundary of [{ lastTurnId: first.id }, { beforeTurnId: source.thread.turns[1].id }]) {
    const threadSource = codexForkSource({ sessionId: session.sessionId, commandId: `fork-${forks.length}` });
    const request = client.request('thread/fork', { threadId: sourceId, ...boundary,
      excludeTurns: true, deferGoalContinuation: true, model: 'gpt-5.5', threadSource });
    let fork;
    if (receiptMode === 'received') fork = await request;
    else {
      await assert.rejects(request, /连接断开/);
      if (receiptMode === 'restart') {
        f.disconnect();
        await f.restartNative();
      }
      client = f.client({ loseForkReceipt: true });
    }
    const recovered = await findCodexForkReceipt({ codexHome: path.join(f.root, '.codex'),
      runtimeHomeHash: require('node:crypto').createHash('sha256')
        .update(fs.realpathSync(path.join(f.root, '.codex'))).digest('hex'),
      sourceThreadId: sourceId, threadSource });
    assert.ok(recovered);
    assert.equal(recovered.threadId, fork?.thread.id || f.lostForkReceipts.at(-1).thread.id);
    assert.equal(recovered.sourceThreadId, sourceId);
    const history = await readCodexHistoryResponse(client, recovered.threadId);
    assert.deepEqual(history.thread.turns.map((turn) => turn.id), [first.id]);
    assert.deepEqual(history.thread.turns[0].items, first.items);
    forks.push(recovered.threadId);
  }
  client = f.client();
  const empty = await client.request('thread/fork', { threadId: sourceId, beforeTurnId: first.id,
    excludeTurns: true, deferGoalContinuation: true, model: 'gpt-5.5' });
  assert.deepEqual((await readCodexHistoryResponse(client, empty.thread.id)).thread.turns, []);
  assert.deepEqual(fs.readFileSync(metadata.thread.path), sourceBytes, 'fork must not change the source rollout');
  assert.equal(f.requests.length, requestsBeforeFork, 'creating a fork must not execute a model turn');

  service.close();
  f.disconnect();
  await f.restartNative();
  client = f.client();
  for (const threadId of forks) {
    await client.request('thread/resume', { threadId, model: 'gpt-5.5' });
    const beforeRequest = f.requests.length;
    const result = await client.request('turn/start', { threadId, model: 'gpt-5.5',
      input: [{ type: 'text', text: 'CHILD_CONTINUE', text_elements: [] }] });
    await waitFor(async () => (await readCodexHistoryResponse(client, threadId)).thread.turns
      .some((turn) => turn.id === result.turn.id && turn.status === 'completed'));
    assert.equal(f.requests.length, beforeRequest + 1);
    const input = f.requests.at(-1).input;
    assert.deepEqual(input.find((item) => item.type === 'reasoning'), originalReasoning);
    assert.equal(originalReasoning.encrypted_content, rawReasoning.encrypted_content);
    const call = input.find((item) => item.type === 'function_call' && item.call_id === 'work-fork-tool');
    const output = input.find((item) => item.type === 'function_call_output' && item.call_id === 'work-fork-tool');
    assert.ok(call);
    assert.match(JSON.stringify(output), /FORK_TOOL_OUTPUT/);
    assert.match(JSON.stringify(input), /SOURCE_KEEP_FIRST/);
    assert.match(JSON.stringify(input), /FORK_ANSWER_2/);
    assert.doesNotMatch(JSON.stringify(input), /SOURCE_EXCLUDE_LATER|FORK_ANSWER_3/);
    assert.equal(fs.readFileSync(path.join(f.root, 'marker'), 'utf8'), 'executed\n');
  }
  assert.deepEqual(fs.readFileSync(metadata.thread.path), sourceBytes);
});

for (const injectionMode of ['received', 'lost', 'restart', 'service', 'service-user', 'service-regenerate', 'service-lost', 'service-legacy'])
test(`native fork before a turn plus private raw prefix cuts at a mid-turn assistant message (${injectionMode})`, {
  skip: !process.env.AIH_TEST_CODEX_EXECUTABLE, timeout: 40000
}, async (t) => {
  const f = await nativeFixture(t, { omitNotificationMedia: true, modelOutput(body, count) {
    const names = (body.tools || []).map((tool) => tool.name);
    const answer = (id, text, phase) => ({ type: 'message', id, role: 'assistant', status: 'completed', phase,
      content: [{ type: 'output_text', text, annotations: [] }] });
    if (count === 1) return [commandToolCall(names, 'fc-before', 'tool-before',
      "printf 'before\\n' >> marker; printf TOOL_BEFORE_CUT")];
    if (count === 2) return [answer('mid-answer', 'EXACT_MIDDLE_MESSAGE', 'commentary'),
      commandToolCall(names, 'fc-after', 'tool-after', "printf 'after\\n' >> marker; printf TOOL_AFTER_CUT")];
    return [answer(`final-${count}`, count === 3 ? 'SOURCE_FINAL_EXCLUDED' : 'CHILD_DONE', 'final_answer')];
  } });
  const service = f.open({ startHistoryMode: injectionMode === 'service-legacy' ? 'legacy' : 'paginated',
    loseForkReceipt: injectionMode === 'service-lost', loseInjectionReceipt: injectionMode === 'service-lost' });
  const session = await service.createSession({ provider: 'codex', executionAccountRef: 'tool-probe',
    projectPath: f.root, policy: { approvalMode: 'bypass' } });
  const imagePath = path.join(f.root, 'input.png');
  fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGNgYPiPhIjiAACOsw/xs6MvMwAAAABJRU5ErkJggg==', 'base64'));
  const attachments = service.store.createAttachments(session.sessionId,
    [{ filePath: imagePath, name: 'input.png', mimeType: 'image/png' }]);
  await service.dispatchCommand(session.sessionId, { commandId: 'mid-turn-source', type: 'turn.submit',
    payload: { content: 'SOURCE_MIDDLE_INPUT', model: 'gpt-5.5', attachmentIds: [attachments[0].attachmentId] } });
  await waitFor(() => service.getSnapshot(session.sessionId).state === 'idle');
  assert.equal(fs.readFileSync(path.join(f.root, 'marker'), 'utf8'), 'before\nafter\n');
  const threadId = service.getSnapshot(session.sessionId).runtimeBinding.nativeSessionId;
  const { readCodexHistoryResponse } = require('../lib/server/chat-runtime/codex-session-history');
  let client = f.client({ loseInjectionReceipt: ['lost', 'restart'].includes(injectionMode) });
  const history = await readCodexHistoryResponse(client, threadId);
  const sourceTurn = history.thread.turns[0];
  const raw = service.store.store.nativeResponseItems.readTurn(session.sessionId, threadId, sourceTurn.id);
  const originalImage = f.requests[0].input.flatMap((item) => item.content || []).find((part) => part.type === 'input_image');
  assert.ok(originalImage);
  assert.deepEqual(raw.flatMap((item) => item.content || []).find((part) => part.type === 'input_image'), originalImage);
  assert.equal(service.store.store.nativeResponseItems.coverage(session.sessionId, threadId, sourceTurn.id), 'complete');
  const { planCodexHistoryFork } = require('../lib/server/chat-runtime/codex-history-fork-plan');
  const planningHistory = injectionMode === 'service-legacy' ? { thread: { ...history.thread,
    turns: history.thread.turns.map((turn) => ({ ...turn, items: service.store.store.nativeThreadItems
      .readTurn(session.sessionId, threadId, turn.id).map((entry) => entry.item) })) } } : history;
  const plan = planCodexHistoryFork({ response: planningHistory, threadId, itemId: 'mid-answer', rawTurn: raw,
    coverage: service.store.store.nativeResponseItems.coverage(session.sessionId, threadId, sourceTurn.id) });
  const sourceBefore = service.getSnapshot(session.sessionId);
  const userTarget = sourceBefore.timeline.find((item) => item.kind === 'message' && item.detail.role === 'user');
  const serviceMode = injectionMode.startsWith('service');
  const command = { sessionId: session.sessionId, commandId: 'mid-turn-fork',
    type: injectionMode === 'service-regenerate' ? 'turn.regenerate' : 'session.fork',
    payload: { sourceItemId: injectionMode === 'service-user' ? userTarget.id : 'mid-answer' } };
  if (!serviceMode) service.store.acceptCommand(command);
  const runtimeHome = { codexHome: path.join(f.root, '.codex'),
    runtimeHomeHash: require('node:crypto').createHash('sha256')
      .update(fs.realpathSync(path.join(f.root, '.codex'))).digest('hex') };
  let repository = service.store.store.branchOperations;
  let native = new CodexBranchOperationPort({ client, model: 'gpt-5.5', getRuntimeHome: async () => runtimeHome });
  const observeInjection = native.inject.bind(native);
  native.inject = async (operation) => {
    assert.equal(await native.recoverInjection(operation), 'absent');
    return observeInjection(operation);
  };
  let ready;
  if (injectionMode === 'restart') {
    native.recoverInjection = async () => { throw new Error('SIMULATED_AIH_EXIT'); };
    // Lose the response and stop before the coordinator can confirm the
    // durable native write; restart recovery must not inject a second time.
    native.inject = observeInjection;
    await assert.rejects(prepareNativeBranch({ repository, command, plan, native }), /SIMULATED_AIH_EXIT/);
    assert.equal(repository.read(command.sessionId, command.commandId).state, 'inject_pending');
    service.close();
    f.disconnect();
    await f.restartNative();
    client = f.client();
    const reopened = require('../lib/server/chat-runtime/store').openChatRuntimeStore({ fs, aiHomeDir: f.root });
    t.after(() => reopened.close());
    repository = reopened.branchOperations;
    native = new CodexBranchOperationPort({ client, model: 'gpt-5.5', getRuntimeHome: async () => runtimeHome });
  }
  let childSession;
  if (serviceMode) {
    childSession = (await service.dispatchCommand(session.sessionId, command)).result.session;
    ready = repository.read(command.sessionId, command.commandId);
    assert.equal(childSession.executionAccountRef, session.executionAccountRef);
    assert.equal(childSession.projectPath, session.projectPath);
    const childTimeline = service.getSnapshot(childSession.sessionId).timeline;
    if (injectionMode !== 'service-regenerate') assert.equal(childTimeline.at(-1).id, command.payload.sourceItemId);
    assert.doesNotMatch(JSON.stringify(childTimeline), /tool-after|SOURCE_FINAL_EXCLUDED/);
    const duplicate = await service.dispatchCommand(session.sessionId, command);
    assert.equal(duplicate.result.session.sessionId, childSession.sessionId);
  } else ready = await prepareNativeBranch({ repository, command, plan, native });
  assert.equal(ready.state, 'ready');
  const fork = { thread: { id: ready.receipt.threadId } };
  const receiptOptions = { ...runtimeHome, sourceThreadId: threadId, threadSource: codexForkSource(command),
    threadId: fork.thread.id, items: ready.plan.items };
  if (injectionMode !== 'service-regenerate') assert.equal(await readCodexInjectionReceipt(receiptOptions), 'complete');
  if (injectionMode === 'restart') await client.request('thread/resume', { threadId: fork.thread.id, model: 'gpt-5.5' });
  if (injectionMode !== 'service-regenerate') assert.equal(f.requests.length, 3, 'fork and injection cannot run the prior tools');
  if (childSession) {
    if (injectionMode !== 'service-regenerate') await service.dispatchCommand(childSession.sessionId, { commandId: 'child-continue', type: 'turn.submit',
      payload: { content: 'CHILD_MIDDLE_CONTINUE', model: 'gpt-5.5' } });
    await waitFor(() => service.getSnapshot(childSession.sessionId).state === 'idle');
    const snapshot = service.getSnapshot(childSession.sessionId);
    assert.equal(snapshot.failedTurn, undefined);
    const childTurns = await readCodexHistoryResponse(client, childSession.runtimeBinding.nativeSessionId);
    assert.equal(repository.store.nativeResponseItems.coverage(childSession.sessionId,
      childSession.runtimeBinding.nativeSessionId, childTurns.thread.turns.at(-1).id), 'incomplete',
    'fork/resume does not opt into raw events; typed turn completion must not certify capture');
    assert.equal(snapshot.timeline.filter((item) => item.id === 'mid-answer').length,
      ['service', 'service-lost', 'service-legacy'].includes(injectionMode) ? 1 : 0);
  } else await client.request('turn/start', { threadId: fork.thread.id, model: 'gpt-5.5',
    input: [{ type: 'text', text: 'CHILD_MIDDLE_CONTINUE', text_elements: [] }] });
  await waitFor(async () => (await readCodexHistoryResponse(client, fork.thread.id)).thread.turns
    .at(-1)?.status === 'completed');
  assert.equal(f.requests.length, 4);
  const nextInput = f.requests.at(-1).input;
  assert.deepEqual(nextInput.flatMap((item) => item.content || []).find((part) => part.type === 'input_image'), originalImage);
  assert.match(JSON.stringify(nextInput), /SOURCE_MIDDLE_INPUT/);
  if (injectionMode === 'service-user' || injectionMode === 'service-regenerate') {
    assert.doesNotMatch(JSON.stringify(nextInput), /EXACT_MIDDLE_MESSAGE|TOOL_BEFORE_CUT|tool-before|TOOL_AFTER_CUT|SOURCE_FINAL_EXCLUDED/);
    assert.equal(fs.readFileSync(path.join(f.root, 'marker'), 'utf8'), 'before\nafter\n');
    assert.deepEqual(repository.store.getSnapshot(session.sessionId), sourceBefore);
    return;
  }
  assert.match(JSON.stringify(nextInput), /EXACT_MIDDLE_MESSAGE/);
  assert.match(JSON.stringify(nextInput), /TOOL_BEFORE_CUT/);
  assert.doesNotMatch(JSON.stringify(nextInput), /TOOL_AFTER_CUT|tool-after|SOURCE_FINAL_EXCLUDED/);
  assert.equal(nextInput.find((item) => item.type === 'message' && item.phase === 'commentary')
    .content[0].text, 'EXACT_MIDDLE_MESSAGE');
  assert.equal(nextInput.filter((entry) => entry.call_id === 'tool-before' && entry.type === 'function_call').length, 1);
  assert.equal(nextInput.filter((entry) => entry.call_id === 'tool-before' && entry.type === 'function_call_output').length, 1);
  assert.equal(nextInput.filter((entry) => entry.type === 'message'
    && entry.content.some((part) => part.text === 'EXACT_MIDDLE_MESSAGE')).length, 1);
  assert.equal(fs.readFileSync(path.join(f.root, 'marker'), 'utf8'), 'before\nafter\n');
  assert.deepEqual(repository.store.getSnapshot(session.sessionId), sourceBefore);
  if (childSession && injectionMode === 'service') {
    const childBefore = service.getSnapshot(childSession.sessionId);
    const grandchild = (await service.dispatchCommand(childSession.sessionId, { commandId: 'nested-cut',
      type: 'session.fork', payload: { sourceItemId: 'mid-answer' } })).result.session;
    assert.equal(grandchild.policy.lineage.parentSessionId, childSession.sessionId);
    assert.equal(service.getSnapshot(grandchild.sessionId).timeline.at(-1).id, 'mid-answer');
    await service.dispatchCommand(grandchild.sessionId, { commandId: 'grandchild-continue', type: 'turn.submit',
      payload: { content: 'GRANDCHILD_CONTINUE', model: 'gpt-5.5' } });
    await waitFor(() => service.getSnapshot(grandchild.sessionId).state === 'idle');
    assert.equal(service.getSnapshot(grandchild.sessionId).failedTurn, undefined);
    assert.match(JSON.stringify(f.requests.at(-1).input), /EXACT_MIDDLE_MESSAGE|TOOL_BEFORE_CUT/);
    assert.doesNotMatch(JSON.stringify(f.requests.at(-1).input), /CHILD_MIDDLE_CONTINUE|TOOL_AFTER_CUT|SOURCE_FINAL_EXCLUDED/);
    assert.equal(fs.readFileSync(path.join(f.root, 'marker'), 'utf8'), 'before\nafter\n');
    assert.deepEqual(service.getSnapshot(childSession.sessionId), childBefore);
    const latestChildAnswer = childBefore.timeline.find((item) => item.id === 'final-4');
    const afterResume = (await service.dispatchCommand(childSession.sessionId, { commandId: 'fork-resumed-turn',
      type: 'session.fork', payload: { sourceItemId: latestChildAnswer.id } })).result.session;
    assert.equal(service.getSnapshot(afterResume.sessionId).timeline.at(-1).id, latestChildAnswer.id);
    await service.dispatchCommand(afterResume.sessionId, { commandId: 'continue-resumed-branch', type: 'turn.submit',
      payload: { content: 'AFTER_RESUME_BRANCH', model: 'gpt-5.5' } });
    await waitFor(() => service.getSnapshot(afterResume.sessionId).state === 'idle');
    assert.equal(service.getSnapshot(afterResume.sessionId).failedTurn, undefined);
    assert.match(JSON.stringify(f.requests.at(-1).input), /CHILD_MIDDLE_CONTINUE/);
    assert.equal(fs.readFileSync(path.join(f.root, 'marker'), 'utf8'), 'before\nafter\n');
    service.close();
    f.disconnect();
    const reopenedService = f.open();
    await reopenedService.waitForRecovery();
    const repeated = await reopenedService.dispatchCommand(session.sessionId, command);
    assert.equal(repeated.result.session.sessionId, childSession.sessionId);
    assert.equal(reopenedService.getSnapshot(childSession.sessionId).timeline.filter((item) => item.id === 'mid-answer').length, 1);
  }
});

async function nativeFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-tool-recovery-'));
  const requests = [];
  const clients = [];
  const sockets = [];
  const resumes = [];
  const lostForkReceipts = [];
  const services = [];
  const gateway = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    fs.writeFileSync(path.join(root, 'requests.json'), JSON.stringify(requests, null, 2));
    if (options.modelOutput) {
      respond(res, options.modelOutput(body, requests.length));
      return;
    }
    if (requests.length === 1) {
      const available = body.tools || body.input.filter((item) => item.type === 'additional_tools').flatMap((item) => item.tools);
      const names = available.map((tool) => tool.name);
      if (options.parallelTools) {
        const first = "printf 'started\\n' > parallel-a-started; while [ ! -f release ]; do sleep 0.05; done; printf A_OUTPUT; printf 'done\\n' > parallel-a-finished";
        const second = "printf B_OUTPUT; printf 'done\\n' > parallel-b-finished";
        respond(res, [
          commandToolCall(names, 'fc-parallel-a', 'parallel-a', first),
          commandToolCall(names, 'fc-parallel-b', 'parallel-b', second)
        ]);
        return;
      }
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
      content: [{ type: 'output_text', text: options.parallelTools ? 'PARALLEL_TOOLS_DONE' : 'TOOL_PROBE_DONE', annotations: [] }] }]);
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
    ...(options.omitNotificationMedia ? ['features.omit_app_server_notification_media = true'] : []),
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
          const payload = JSON.parse(String(data));
          if (payload.method === 'thread/fork' && options.loseForkReceipt) this.lostForkRequestId = payload.id;
          if (payload.method === 'thread/inject_items' && options.loseInjectionReceipt) this.lostInjectionRequestId = payload.id;
          if (payload.method === 'thread/start' && options.startHistoryMode) {
            payload.params.historyMode = options.startHistoryMode;
            data = JSON.stringify(payload);
          }
          if (payload.method === 'thread/resume' && options.resumeInitialTurnsPage) {
            payload.params.initialTurnsPage = options.resumeInitialTurnsPage;
            data = JSON.stringify(payload);
          }
          if (payload.method === 'turn/start') {
            if (options.dropStartRequest) { this.terminate(); return; }
            if (options.loseStartReceipt) this.loseReceipt = true;
          }
          return super.send(data, ...args);
        }
        emit(event, ...args) {
          if (event === 'message' && this.loseReceipt) return true;
          if (event === 'message' && this.lostInjectionRequestId) {
            const message = JSON.parse(String(args[0]));
            if (message.id === this.lostInjectionRequestId && message.result) {
              this.terminate();
              return true;
            }
          }
          if (event === 'message' && this.lostForkRequestId) {
            const message = JSON.parse(String(args[0]));
            if (message.id === this.lostForkRequestId && message.result) {
              lostForkReceipts.push(message.result);
              this.terminate();
              return true;
            }
          }
          if (event === 'message') fs.appendFileSync(path.join(root, 'rpc-responses.jsonl'), `${String(args[0])}\n`);
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
    }, async onReconnectResume(response, historyClient) {
      await handlers.onReconnectResume(response, historyClient);
      resumes.push(response);
    } });
    clients.push(instance);
    return instance;
  };
  return { root, requests, client, sockets, resumes, lostForkReceipts, disconnect: () => clients.forEach((c) => c.destroy()),
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
            runtimeHomeHash: require('node:crypto').createHash('sha256').update(fs.realpathSync(codexHome)).digest('hex'),
            executionAccountHash: require('node:crypto').createHash('sha256').update('tool-probe').digest('hex') };
        }, codexClientFactory: (options) => client({ ...options, ...clientOverrides }) });
      services.push(service);
      return service;
    } };
}

function commandToolCall(names, id, callId, command) {
  const name = names.includes('exec_command') ? 'exec_command'
    : names.includes('shell_command') ? 'shell_command'
      : 'shell';
  const args = name === 'exec_command' ? { cmd: command, yield_time_ms: 10000, max_output_tokens: 200 }
    : name === 'shell_command' ? { command, timeout_ms: 10000 }
      : { command: ['/bin/sh', '-c', command], timeout_ms: 10000 };
  return { type: 'function_call', id, call_id: callId, name, arguments: JSON.stringify(args) };
}

function toolHistoryOrder(input) {
  return input.flatMap((item) => {
    if (['function_call', 'custom_tool_call'].includes(item.type)) {
      return [`call:${item.call_id}`];
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(item.type)) {
      return [`output:${item.call_id}`];
    }
    return [];
  }).filter((entry) => entry.includes('parallel-'));
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
