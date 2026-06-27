'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildForwardedSessionCommandPayload,
  executeRemoteDevelopmentSessionCommand,
  normalizeSessionCommandPayload
} = require('../lib/server/control-plane-device-session-command');

test('session command normalizes message envelope with idempotency key', () => {
  const command = normalizeSessionCommandPayload({
    type: 'message',
    sessionId: 'run-1',
    text: 'hello',
    idempotencyKey: 'idem-1'
  });

  assert.equal(command.type, 'message');
  assert.equal(command.sessionId, 'run-1');
  assert.equal(command.commandId, 'idem-1');
  assert.equal(command.idempotencyKey, 'idem-1');
  assert.equal(command.input, 'hello');
});

test('session command slash cannot carry approval prompt identity', () => {
  assert.throws(
    () => normalizeSessionCommandPayload({
      type: 'slash',
      sessionId: 'run-1',
      command: '/status',
      promptId: 'codex-plan-active',
      idempotencyKey: 'idem-slash'
    }),
    { code: 'slash_command_must_not_carry_approval_id' }
  );
});

test('session command executes message and returns cursor ack without echoing input', async () => {
  const writes = [];
  const ack = await executeRemoteDevelopmentSessionCommand({
    type: 'message',
    sessionId: 'run-message-1',
    commandId: 'cmd-message-1',
    idempotencyKey: 'idem-message-1',
    text: 'continue'
  }, {
    writeNativeSessionRunInput(payload) {
      writes.push(payload);
      return { accepted: true, runId: payload.runId };
    },
    readNativeSessionRunEvents(query) {
      assert.equal(query.runId, 'run-message-1');
      return { cursor: 12, events: [] };
    }
  });

  assert.deepEqual(writes, [{
    runId: 'run-message-1',
    input: 'continue',
    appendNewline: true
  }]);
  assert.deepEqual(ack, {
    accepted: true,
    commandId: 'cmd-message-1',
    idempotencyKey: 'idem-message-1',
    type: 'message',
    sessionId: 'run-message-1',
    runId: 'run-message-1',
    cursor: 12
  });
  assert.doesNotMatch(JSON.stringify(ack), /continue/);
});

test('session command executes slash as a separate command type', async () => {
  let observed = null;
  const ack = await executeRemoteDevelopmentSessionCommand({
    type: 'slash',
    sessionId: 'run-slash-1',
    command: '/model',
    args: ['gpt-5.5'],
    idempotencyKey: 'idem-slash-1'
  }, {
    writeNativeSessionRunInput(payload) {
      observed = payload;
      return { accepted: true, runId: payload.runId };
    }
  });

  assert.deepEqual(observed, {
    runId: 'run-slash-1',
    input: '/model gpt-5.5',
    appendNewline: true
  });
  assert.equal(ack.type, 'slash');
  assert.equal(ack.command, '/model');
  assert.equal(ack.idempotencyKey, 'idem-slash-1');
});

test('session command approval response carries approval id separately from slash', async () => {
  let observed = null;
  const ack = await executeRemoteDevelopmentSessionCommand({
    type: 'approval_response',
    sessionId: 'run-approval-1',
    approvalId: 'codex-plan-active',
    decision: 'approve',
    response: '1',
    idempotencyKey: 'idem-approval-1'
  }, {
    writeNativeSessionRunInput(payload) {
      observed = payload;
      return { accepted: true, runId: payload.runId };
    }
  });

  assert.deepEqual(observed, {
    runId: 'run-approval-1',
    input: '1',
    appendNewline: true,
    promptId: 'codex-plan-active'
  });
  assert.equal(ack.type, 'approval_response');
  assert.equal(ack.approvalId, 'codex-plan-active');
  assert.equal(ack.decision, 'approve');
});

test('session command stop requires explicit run or session scope', async () => {
  let observed = null;
  const ack = await executeRemoteDevelopmentSessionCommand({
    type: 'stop',
    sessionId: 'run-stop-1',
    scope: 'run',
    idempotencyKey: 'idem-stop-1'
  }, {
    abortNativeSessionRun(payload) {
      observed = payload;
      return { accepted: true, runId: payload.runId };
    }
  });

  assert.deepEqual(observed, { runId: 'run-stop-1' });
  assert.equal(ack.type, 'stop');
  assert.equal(ack.scope, 'run');
});

test('session command falls back to public session ref input when active run id is not found', async () => {
  let snapshotLoaded = false;
  let observed = null;
  const ack = await executeRemoteDevelopmentSessionCommand({
    type: 'message',
    sessionId: 'sess_0123456789abcdefabcd',
    text: 'fallback input',
    idempotencyKey: 'idem-session-ref'
  }, {
    writeNativeSessionRunInput() {
      const error = new Error('native_chat_run_not_found');
      error.code = 'native_chat_run_not_found';
      error.statusCode = 404;
      throw error;
    },
    async loadProjectsSnapshot() {
      snapshotLoaded = true;
      return { projects: [] };
    },
    writeDeviceSessionInput(snapshot, payload) {
      observed = { snapshot, payload };
      return { accepted: true };
    }
  });

  assert.equal(snapshotLoaded, true);
  assert.deepEqual(observed.payload, {
    sessionRef: 'sess_0123456789abcdefabcd',
    input: 'fallback input',
    appendNewline: true
  });
  assert.equal(ack.sessionRef, 'sess_0123456789abcdefabcd');
});

test('forwarded session command payload filters node-only and ignored fields', () => {
  const forwarded = buildForwardedSessionCommandPayload({
    nodeId: 'office-pc',
    ignored: 'no',
    type: 'slash',
    sessionId: 'run-remote-1',
    command: '/status',
    args: '--json',
    idempotencyKey: 'idem-forward'
  });

  assert.deepEqual(forwarded, {
    type: 'slash',
    sessionId: 'run-remote-1',
    commandId: 'idem-forward',
    idempotencyKey: 'idem-forward',
    command: '/status',
    args: '--json'
  });
});
