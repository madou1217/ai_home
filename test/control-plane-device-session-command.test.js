'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildForwardedSessionCommandPayload,
  clearSessionCommandAcks,
  executeRemoteDevelopmentSessionCommand,
  normalizeSessionCommandPayload
} = require('../lib/server/control-plane-device-session-command');
const { getPublicAccountRef } = require('../lib/account/public-account-ref');

const OPENCODE_ACCOUNT_REF = getPublicAccountRef('unique:opencode-command@example.com');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

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
    aiHomeDir: '/tmp/aih-command-home',
    writeNativeSessionRunInput(payload) {
      writes.push(payload);
      return { accepted: true, runId: payload.runId };
    },
    readNativeSessionRunEvents(query) {
      assert.equal(query.runId, 'run-message-1');
      assert.equal(query.aiHomeDir, '/tmp/aih-command-home');
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

test('session command resumes completed opencode run instead of writing stale pty input', async () => {
  clearSessionCommandAcks();
  const writes = [];
  let started = null;
  const ack = await executeRemoteDevelopmentSessionCommand({
    type: 'message',
    sessionId: 'run-opencode-parent',
    commandId: 'cmd-opencode-resume',
    idempotencyKey: 'idem-opencode-resume',
    text: 'next turn'
  }, {
    aiHomeDir: '/tmp/aih-command-home',
    getNativeChatRun(runId) {
      assert.equal(runId, 'run-opencode-parent');
      return {
        runId,
        provider: 'opencode',
        accountRef: OPENCODE_ACCOUNT_REF,
        sessionId: 'ses_opencode_real',
        projectPath: '/repo/project',
        completed: true
      };
    },
    writeNativeSessionRunInput(payload) {
      writes.push(payload);
      return { accepted: true, runId: payload.runId };
    },
    startNativeDeviceSession(payload, deps) {
      started = { payload, deps };
      return {
        accepted: true,
        status: 'running',
        runId: 'run-opencode-child',
        sessionId: 'ses_opencode_real',
        stream: { cursor: 1 }
      };
    }
  });

  assert.deepEqual(writes, []);
  assert.deepEqual(started.payload, {
    provider: 'opencode',
    accountRef: OPENCODE_ACCOUNT_REF,
    prompt: 'next turn',
    projectPath: '/repo/project',
    projectDirName: '',
    sessionId: 'ses_opencode_real'
  });
  assert.equal(started.deps.aiHomeDir, '/tmp/aih-command-home');
  assert.deepEqual(ack, {
    accepted: true,
    commandId: 'cmd-opencode-resume',
    idempotencyKey: 'idem-opencode-resume',
    type: 'message',
    sessionId: 'run-opencode-parent',
    runId: 'run-opencode-child',
    sessionRef: 'ses_opencode_real',
    cursor: 1,
    resumed: true,
    resumedFromRunId: 'run-opencode-parent',
    provider: 'opencode',
    status: 'running'
  });
  assert.doesNotMatch(JSON.stringify(ack), /next turn/);
});

test('session command resumes completed opencode slash through interactive native run', async () => {
  clearSessionCommandAcks();
  let started = null;
  const ack = await executeRemoteDevelopmentSessionCommand({
    type: 'slash',
    sessionId: 'run-opencode-slash-parent',
    command: '/status',
    idempotencyKey: 'idem-opencode-slash-resume'
  }, {
    aiHomeDir: '/tmp/aih-command-home',
    getNativeChatRun(runId) {
      assert.equal(runId, 'run-opencode-slash-parent');
      return {
        runId,
        provider: 'opencode',
        accountRef: OPENCODE_ACCOUNT_REF,
        sessionId: 'ses_opencode_slash',
        projectPath: '/repo/project',
        completed: true
      };
    },
    writeNativeSessionRunInput() {
      throw new Error('should_not_write_stale_run');
    },
    startNativeDeviceSession(payload, deps) {
      started = { payload, deps };
      return {
        accepted: true,
        status: 'running',
        runId: 'run-opencode-slash-child',
        sessionId: 'ses_opencode_slash',
        stream: { cursor: 1 }
      };
    }
  });

  assert.deepEqual(started.payload, {
    provider: 'opencode',
    accountRef: OPENCODE_ACCOUNT_REF,
    prompt: '',
    initialInput: '/status',
    interactiveCli: true,
    projectPath: '/repo/project',
    projectDirName: '',
    sessionId: 'ses_opencode_slash'
  });
  assert.equal(started.deps.aiHomeDir, '/tmp/aih-command-home');
  assert.deepEqual(ack, {
    accepted: true,
    commandId: 'idem-opencode-slash-resume',
    idempotencyKey: 'idem-opencode-slash-resume',
    type: 'slash',
    sessionId: 'run-opencode-slash-parent',
    runId: 'run-opencode-slash-child',
    sessionRef: 'ses_opencode_slash',
    cursor: 1,
    command: '/status',
    resumed: true,
    resumedFromRunId: 'run-opencode-slash-parent',
    provider: 'opencode',
    status: 'running'
  });
});

test('session command rejects headless message while source run is still running', async () => {
  clearSessionCommandAcks();
  await assert.rejects(
    () => executeRemoteDevelopmentSessionCommand({
      type: 'message',
      sessionId: 'run-opencode-busy',
      idempotencyKey: 'idem-opencode-busy',
      text: 'do this now'
    }, {
      getNativeChatRun(runId) {
        return {
          runId,
          provider: 'opencode',
          accountRef: OPENCODE_ACCOUNT_REF,
          sessionId: 'ses_opencode_busy',
          projectPath: '/repo/project',
          completed: false
        };
      },
      writeNativeSessionRunInput() {
        throw new Error('should_not_write');
      }
    }),
    { code: 'headless_session_run_still_running', statusCode: 409 }
  );
});

test('session command resumes persisted opencode run metadata after active handle is gone', async () => {
  clearSessionCommandAcks();
  let startedPayload = null;
  const ack = await executeRemoteDevelopmentSessionCommand({
    type: 'message',
    sessionId: 'run-opencode-persisted',
    idempotencyKey: 'idem-opencode-persisted',
    text: 'persisted next turn'
  }, {
    aiHomeDir: '/tmp/aih-command-home',
    getNativeChatRun() {
      return null;
    },
    readNativeSessionRunEvents(query) {
      assert.equal(query.runId, 'run-opencode-persisted');
      assert.equal(query.aiHomeDir, '/tmp/aih-command-home');
      return {
        runId: query.runId,
        provider: 'opencode',
        accountRef: OPENCODE_ACCOUNT_REF,
        sessionId: 'ses_opencode_persisted',
        projectDirName: '',
        projectPath: '/repo/project',
        status: 'completed',
        completed: true,
        persisted: true,
        cursor: 8,
        events: []
      };
    },
    startNativeDeviceSession(payload) {
      startedPayload = payload;
      return {
        accepted: true,
        status: 'running',
        runId: 'run-opencode-persisted-child',
        sessionId: payload.sessionId,
        stream: { cursor: 1 }
      };
    }
  });

  assert.equal(startedPayload.sessionId, 'ses_opencode_persisted');
  assert.equal(startedPayload.prompt, 'persisted next turn');
  assert.equal(ack.runId, 'run-opencode-persisted-child');
  assert.equal(ack.resumed, true);
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
  clearSessionCommandAcks();
  let observed = null;
  const ack = await executeRemoteDevelopmentSessionCommand({
    type: 'approval_response',
    sessionId: 'run-approval-1',
    approvalId: 'codex-plan-active',
    decision: 'approve',
    response: '1',
    idempotencyKey: 'idem-approval-1' // gitleaks:allow
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

test('session command idempotency returns prior approval response without rewriting input', async () => {
  clearSessionCommandAcks();
  const writes = [];
  const input = {
    type: 'approval_response',
    sessionId: 'run-approval-idempotent',
    approvalId: 'codex-plan-active',
    decision: 'approve',
    response: '1',
    idempotencyKey: 'idem-approval-repeat'
  };

  const first = await executeRemoteDevelopmentSessionCommand(input, {
    writeNativeSessionRunInput(payload) {
      writes.push(payload);
      return { accepted: true, runId: payload.runId };
    },
    readNativeSessionRunEvents() {
      return { cursor: 19, events: [] };
    }
  });
  const duplicate = await executeRemoteDevelopmentSessionCommand(input, {
    writeNativeSessionRunInput(payload) {
      writes.push(payload);
      return { accepted: true, runId: payload.runId };
    },
    readNativeSessionRunEvents() {
      return { cursor: 20, events: [] };
    }
  });

  assert.equal(writes.length, 1);
  assert.equal(first.cursor, 19);
  assert.deepEqual(duplicate, {
    ...first,
    duplicate: true
  });
});

test('session command idempotency rejects conflicting payload reuse', async () => {
  clearSessionCommandAcks();
  await executeRemoteDevelopmentSessionCommand({
    type: 'approval_response',
    sessionId: 'run-approval-conflict',
    approvalId: 'codex-plan-active',
    decision: 'approve',
    idempotencyKey: 'idem-approval-conflict'
  }, {
    writeNativeSessionRunInput() {
      return { accepted: true, runId: 'run-approval-conflict' };
    }
  });

  await assert.rejects(
    () => executeRemoteDevelopmentSessionCommand({
      type: 'approval_response',
      sessionId: 'run-approval-conflict',
      approvalId: 'codex-plan-active',
      decision: 'reject',
      idempotencyKey: 'idem-approval-conflict'
    }, {
      writeNativeSessionRunInput() {
        return { accepted: true, runId: 'run-approval-conflict' };
      }
    }),
    { code: 'session_command_idempotency_conflict' }
  );
});

test('session command stop requires explicit run or session scope', async () => {
  clearSessionCommandAcks();
  let observed = null;
  const ack = await executeRemoteDevelopmentSessionCommand({
    type: 'stop',
    sessionId: 'run-stop-1',
    scope: 'run',
    idempotencyKey: 'idem-stop-1'
  }, {
    aiHomeDir: '/tmp/aih-command-home',
    abortNativeSessionRun(payload, deps) {
      observed = { payload, deps };
      return { accepted: true, runId: payload.runId };
    }
  });

  assert.deepEqual(observed, {
    payload: { runId: 'run-stop-1' },
    deps: {
      unregisterNativeChatRun: undefined,
      aiHomeDir: '/tmp/aih-command-home'
    }
  });
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

test('session command serializes concurrent commands for the same session', async (t) => {
  clearSessionCommandAcks();
  t.after(() => clearSessionCommandAcks());
  const firstWrite = createDeferred();
  const settleGates = [];
  const writes = [];
  const deps = {
    writeNativeSessionRunInput(payload) {
      writes.push(payload);
      if (payload.input === 'first message') return firstWrite.promise;
      return { accepted: true, runId: payload.runId };
    },
    waitForSessionCommandSettle() {
      const gate = createDeferred();
      settleGates.push(gate);
      return gate.promise;
    }
  };

  const first = executeRemoteDevelopmentSessionCommand({
    type: 'message',
    sessionId: 'run-serial-1',
    text: 'first message',
    idempotencyKey: 'idem-serial-1'
  }, deps);
  await flushMicrotasks();
  assert.equal(writes.length, 1);

  const second = executeRemoteDevelopmentSessionCommand({
    type: 'slash',
    sessionId: 'run-serial-1',
    command: '/status',
    idempotencyKey: 'idem-serial-2'
  }, deps);
  await flushMicrotasks();
  assert.equal(writes.length, 1);

  firstWrite.resolve({ accepted: true, runId: 'run-serial-1' });
  const firstAck = await first;
  await flushMicrotasks();
  assert.equal(firstAck.type, 'message');
  assert.equal(settleGates.length, 1);
  assert.equal(writes.length, 1);

  settleGates[0].resolve();
  const secondAck = await second;
  assert.equal(secondAck.type, 'slash');
  assert.deepEqual(writes.map((payload) => payload.input), ['first message', '/status']);
});

test('session command queue is scoped to one session id', async (t) => {
  clearSessionCommandAcks();
  t.after(() => clearSessionCommandAcks());
  const firstWrite = createDeferred();
  const writes = [];
  const deps = {
    sessionCommandSettleDelayMs: 0,
    writeNativeSessionRunInput(payload) {
      writes.push(payload);
      if (payload.runId === 'run-parallel-a') return firstWrite.promise;
      return { accepted: true, runId: payload.runId };
    }
  };

  const first = executeRemoteDevelopmentSessionCommand({
    type: 'message',
    sessionId: 'run-parallel-a',
    text: 'blocked',
    idempotencyKey: 'idem-parallel-a'
  }, deps);
  await flushMicrotasks();
  assert.equal(writes.length, 1);

  const secondAck = await executeRemoteDevelopmentSessionCommand({
    type: 'slash',
    sessionId: 'run-parallel-b',
    command: '/status',
    idempotencyKey: 'idem-parallel-b'
  }, deps);
  assert.equal(secondAck.sessionId, 'run-parallel-b');
  assert.deepEqual(writes.map((payload) => payload.runId), ['run-parallel-a', 'run-parallel-b']);

  firstWrite.resolve({ accepted: true, runId: 'run-parallel-a' });
  await first;
});

test('session command idempotency reuses an in-flight command without rewriting input', async (t) => {
  clearSessionCommandAcks();
  t.after(() => clearSessionCommandAcks());
  const firstWrite = createDeferred();
  const writes = [];
  const payload = {
    type: 'message',
    sessionId: 'run-idem-inflight',
    text: 'only once',
    idempotencyKey: 'idem-inflight'
  };
  const deps = {
    sessionCommandSettleDelayMs: 0,
    writeNativeSessionRunInput(writePayload) {
      writes.push(writePayload);
      return firstWrite.promise;
    }
  };

  const first = executeRemoteDevelopmentSessionCommand(payload, deps);
  await flushMicrotasks();
  const duplicate = executeRemoteDevelopmentSessionCommand(payload, deps);
  await flushMicrotasks();
  assert.equal(writes.length, 1);

  firstWrite.resolve({ accepted: true, runId: 'run-idem-inflight' });
  const [firstAck, duplicateAck] = await Promise.all([first, duplicate]);
  assert.equal(writes.length, 1);
  assert.equal(firstAck.duplicate, undefined);
  assert.deepEqual(duplicateAck, {
    ...firstAck,
    duplicate: true
  });
});

test('session command queue continues after a failed command settles', async (t) => {
  clearSessionCommandAcks();
  t.after(() => clearSessionCommandAcks());
  const settleGates = [];
  const writes = [];
  const deps = {
    writeNativeSessionRunInput(payload) {
      writes.push(payload);
      if (payload.input === 'fail first') {
        const error = new Error('native_write_failed');
        error.code = 'native_write_failed';
        throw error;
      }
      return { accepted: true, runId: payload.runId };
    },
    waitForSessionCommandSettle() {
      const gate = createDeferred();
      settleGates.push(gate);
      return gate.promise;
    }
  };

  await assert.rejects(
    () => executeRemoteDevelopmentSessionCommand({
      type: 'message',
      sessionId: 'run-failure-continues',
      text: 'fail first',
      idempotencyKey: 'idem-failure-1'
    }, deps),
    { code: 'native_write_failed' }
  );
  await flushMicrotasks();
  assert.equal(settleGates.length, 1);

  const next = executeRemoteDevelopmentSessionCommand({
    type: 'slash',
    sessionId: 'run-failure-continues',
    command: '/status',
    idempotencyKey: 'idem-failure-2'
  }, deps);
  await flushMicrotasks();
  assert.deepEqual(writes.map((payload) => payload.input), ['fail first']);

  settleGates[0].resolve();
  const nextAck = await next;
  assert.equal(nextAck.type, 'slash');
  assert.deepEqual(writes.map((payload) => payload.input), ['fail first', '/status']);
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
