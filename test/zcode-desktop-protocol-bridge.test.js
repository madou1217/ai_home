'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createZcodeDesktopProtocolBridge } = require('../lib/runtime/zcode-desktop-protocol-bridge');
const { readPrivateJson, writePrivateJson } = require('../lib/runtime/codebuddy-ide-bridge-files');
const { identityFingerprint } = require('../lib/runtime/zcode-desktop-bridge-binding');

const SESSION = 'sess_original';

async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'expected bridge state was not reached');
}

function harness(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-bridge-')));
  const binding = { version: 'test', accountRef: 'acct_0123456789abcdef0123', identity: 'native-user',
    profileDir: root, mailboxDir: path.join(root, 'mailbox') };
  let matches = true;
  let snapshot = { session: { sessionId: SESSION, workspace: { workspacePath: root }, status: 'idle',
    model: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' } },
  settings: { mode: { current: 'build' }, model: { current: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' } } },
  projection: { status: 'idle' }, runtime: { stateRevision: 2 } };
  const protocol = new EventEmitter(), calls = [];
  let responder = async (method, params) => {
    if (method === 'session/resume') return snapshot;
    if (method === 'session/setMode') {
      snapshot = { ...snapshot, runtime: { stateRevision: 3 }, settings: { ...snapshot.settings, mode: { current: params.mode } } };
      return snapshot;
    }
    if (method === 'session/send') {
      protocol.emit('message', { method: 'state.updated', params: { sessionId: SESSION, reason: 'prompt_started', revision: 4 } });
      return { accepted: true, sessionId: SESSION, stateRevision: 4 };
    }
    return {};
  };
  protocol.request = async (method, params) => { calls.push({ method, params }); return responder(method, params); };
  const bridge = createZcodeDesktopProtocolBridge({ binding, protocol, cwd: root, identityMatches: () => matches });
  bridge.start();
  protocol.emit('input', { id: 'desktop-config', method: 'provider/updateAccountConfig' });
  protocol.emit('message', { id: 'desktop-config', result: { status: 'received' } });
  t.after(() => { bridge.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const enqueue = (overrides = {}) => {
    const request = { runId: crypto.randomUUID(), hostId: String(process.pid), accountRef: binding.accountRef,
      identity: binding.identity, sessionId: SESSION, cwd: root, prompt: 'Continue the original task',
      model: 'GLM-5.3-Flash', approvalMode: 'bypass', expiresAt: Date.now() + 10000, ...overrides };
    writePrivateJson(path.join(binding.mailboxDir, 'requests', `${request.runId}.json`), request);
    return request;
  };
  return { root, binding, protocol, bridge, calls, enqueue,
    result: request => readPrivateJson(path.join(binding.mailboxDir, 'results', `${request.runId}.json`)),
    writer: () => readPrivateJson(path.join(binding.mailboxDir, `writer-${SESSION}.json`)),
    cancel: request => writePrivateJson(path.join(binding.mailboxDir, 'cancellations', `${request.runId}.json`),
      { runId: request.runId, hostId: String(process.pid) }),
    complete: (reason = 'prompt_completed', revision = 5) => protocol.emit('message', {
      method: 'state.updated', params: { sessionId: SESSION, reason, revision }
    }),
    setIdentity: value => { matches = value; }, setSnapshot: value => { snapshot = { ...snapshot, ...value }; },
    setResponder: value => { responder = value; }
  };
}

test('identity fingerprints reject conflicting OAuth subjects without exposing tokens', () => {
  const token = sub => `e30.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.c2ln`;
  assert.match(identityFingerprint({ userInfo: { user_id: 'first' }, jwtToken: token('first') }), /^[a-f0-9]{64}$/);
  assert.equal(identityFingerprint({ userInfo: { user_id: 'first' }, jwtToken: token('second') }), '');
});

test('bridge readiness requires successful native account configuration and current identity', t => {
  const h = harness(t);
  h.bridge.heartbeat();
  const status = () => readPrivateJson(path.join(h.binding.mailboxDir, 'hosts', `${process.pid}.json`));
  assert.equal(status().ready, true);
  h.setIdentity(false); h.bridge.heartbeat();
  assert.equal(status().ready, false);
  h.setIdentity(true);
  h.protocol.emit('input', { id: 'config-failed', method: 'provider/updateAccountConfig' });
  h.protocol.emit('message', { id: 'config-failed', error: { code: -1 } });
  h.bridge.heartbeat();
  assert.equal(status().ready, false);
});

test('current Desktop v4 subscriptions advertise only successfully opened exact sessions', t => {
  const h = harness(t);
  const status = () => readPrivateJson(path.join(h.binding.mailboxDir, 'hosts', `${process.pid}.json`));
  h.protocol.emit('input', { id: 'v4-open', method: 'v4/conversation/subscribe',
    params: { topic: `conversation/${SESSION}`, workspace: { workspacePath: h.root } } });
  h.protocol.emit('message', { id: 'v4-open', result: { ack: {} } });
  h.protocol.emit('input', { id: 'v4-failed', method: 'v4/conversation/subscribe',
    params: { topic: 'conversation/sess_missing', workspace: { workspacePath: h.root } } });
  h.protocol.emit('message', { id: 'v4-failed', error: { code: -1 } });
  h.bridge.heartbeat();
  assert.deepEqual(status().sessions, [{ sessionId: SESSION, cwd: h.root }]);
});

test('exact session resume guards native revisions and settles only its accepted turn', async t => {
  const h = harness(t), request = h.enqueue();
  await h.bridge.poll();
  await until(() => h.calls.some(call => call.method === 'session/send'));
  assert.equal(h.calls[0].params.sessionId, SESSION);
  assert.equal(h.calls.find(call => call.method === 'session/setMode').params.expectedRevision, 2);
  assert.equal(h.calls.find(call => call.method === 'session/send').params.expectedRevision, 3);
  h.complete('prompt_completed', 1);
  assert.equal(h.result(request).state, 'dispatched');
  h.complete();
  assert.equal(h.result(request).state, 'settled');
  assert.equal(h.writer(), null);
});

test('identity, account, workspace, busy state and provider/model mismatches reject before sending', async t => {
  for (const failure of ['identity', 'account', 'workspace', 'busy', 'model']) {
    const h = harness(t);
    const request = h.enqueue(failure === 'account' ? { accountRef: 'acct_ffffffffffffffffffff' }
      : failure === 'workspace' ? { cwd: path.dirname(h.root) }
        : failure === 'model' ? { model: 'account:other/GLM-5.3-Flash' } : {});
    if (failure === 'identity') h.setIdentity(false);
    if (failure === 'busy') h.setSnapshot({ projection: { status: 'waiting' } });
    await h.bridge.poll();
    await until(() => h.result(request)?.error);
    assert.equal(h.calls.some(call => call.method === 'session/send'), false, failure);
  }
});

test('accepted mailbox files cannot be replayed after completion or by another bridge', async t => {
  const h = harness(t), request = h.enqueue();
  await h.bridge.poll();
  await until(() => h.calls.some(call => call.method === 'session/send'));
  h.complete();
  const file = path.join(h.binding.mailboxDir, 'requests', `${request.runId}.json`);
  fs.copyFileSync(`${file}.accepted`, file);
  await h.bridge.poll();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.calls.filter(call => call.method === 'session/send').length, 1);
  assert.equal(h.result(request).state, 'settled');
});

test('cancellation before dispatch never stops an unrelated native turn or sends a prompt', async t => {
  const h = harness(t);
  let resume;
  h.setResponder(method => method === 'session/resume' ? new Promise(resolve => { resume = resolve; }) : {});
  const request = h.enqueue();
  await h.bridge.poll();
  await until(() => resume);
  h.cancel(request);
  await h.bridge.poll();
  resume({ session: { sessionId: SESSION, workspace: { workspacePath: h.root }, status: 'idle', model: 'GLM-5.3-Flash' }, runtime: { stateRevision: 2 } });
  await until(() => h.result(request)?.error);
  assert.equal(h.result(request).error, 'native_session_aborted');
  assert.equal(h.calls.some(call => ['session/stop', 'session/send'].includes(call.method)), false);
  assert.equal(h.writer(), null);
});

test('an immediate cancellation is observed before a queued request is resumed', async t => {
  const h = harness(t), request = h.enqueue();
  h.cancel(request);
  await h.bridge.poll();
  await until(() => h.result(request)?.error);
  assert.equal(h.result(request).error, 'native_session_aborted');
  assert.equal(h.calls.length, 0);
});

test('an uncertain send timeout retains the writer until native completion, without replay', async t => {
  const h = harness(t);
  h.setSnapshot({ settings: { mode: { current: 'yolo' }, model: { current: 'GLM-5.3-Flash' } } });
  h.setResponder(async method => {
    if (method === 'session/resume') return { session: { sessionId: SESSION, workspace: { workspacePath: h.root }, status: 'idle', model: 'GLM-5.3-Flash' }, runtime: { stateRevision: 2 }, settings: { mode: { current: 'yolo' } } };
    if (method === 'session/send') {
      h.protocol.emit('message', { method: 'state.updated', params: { sessionId: SESSION, reason: 'prompt_started', revision: 4 } });
      throw Object.assign(new Error('uncertain outcome'), { code: 'zcode_desktop_protocol_timeout' });
    }
    return {};
  });
  const first = h.enqueue();
  await h.bridge.poll();
  await until(() => h.result(first)?.error);
  assert.equal(h.writer()?.runId, first.runId);
  const second = h.enqueue(); await h.bridge.poll();
  await until(() => h.result(second)?.error);
  assert.equal(h.result(second).error, 'native_session_busy');
  assert.equal(h.calls.filter(call => call.method === 'session/send').length, 1);
  h.complete();
  assert.equal(h.writer(), null);
});

test('native cancellation keeps the writer until the native terminal event', async t => {
  const h = harness(t), request = h.enqueue();
  await h.bridge.poll();
  await until(() => h.calls.some(call => call.method === 'session/send'));
  h.cancel(request); await h.bridge.poll();
  assert.equal(h.calls.filter(call => call.method === 'session/stop').length, 1);
  assert.equal(h.writer()?.runId, request.runId);
  h.complete('prompt_failed');
  assert.equal(h.result(request).error, 'native_session_aborted');
  assert.equal(h.writer(), null);
});
