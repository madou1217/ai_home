'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ChatRuntimeExtensionPipeline,
  createChatRuntimeExtensionPipeline
} = require('../lib/server/chat-runtime/chat-runtime-extension-pipeline');
const { CodexSessionEventBridge } = require('../lib/server/chat-runtime/codex-session-event-bridge');
const { SessionActor } = require('../lib/server/chat-runtime/session-actor');
const { openChatRuntimeStore } = require('../lib/server/chat-runtime/store');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

test('extension pipeline runs waterfall and serial hooks in registration order', async () => {
  const calls = [];
  const pipeline = new ChatRuntimeExtensionPipeline({ extensions: [
    {
      prepareNextTurn: async (command) => {
        calls.push('prepare:first');
        return { ...command, payload: { ...command.payload, content: `${command.payload.content}!` } };
      },
      beforeCommand: async (command) => calls.push(`before:first:${command.payload.content}`)
    },
    {
      prepareNextTurn: (command) => {
        calls.push('prepare:second');
        return { ...command, payload: { ...command.payload, content: command.payload.content.toUpperCase() } };
      },
      beforeCommand: (command) => calls.push(`before:second:${command.payload.content}`)
    }
  ] });

  const command = await pipeline.runWaterfall('prepareNextTurn', {
    commandId: 'c1', sessionId: 's1', payload: { content: 'go' }
  }, { sessionId: 's1' });
  await pipeline.runSerial('beforeCommand', command, { sessionId: 's1' });

  assert.equal(command.payload.content, 'GO!');
  assert.deepEqual(calls, [
    'prepare:first', 'prepare:second', 'before:first:GO!', 'before:second:GO!'
  ]);
});

test('observer failures are isolated and async failures are reported', async () => {
  const errors = [];
  const pipeline = createChatRuntimeExtensionPipeline({
    onObserverError: (error) => errors.push(error.message),
    extensions: [
      { observe: () => { throw new Error('sync observer'); } },
      { observe: async () => { throw new Error('async observer'); } },
      { observe: () => errors.push('healthy observer') }
    ]
  });

  pipeline.observe({ type: 'event' }, { sessionId: 's1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['sync observer', 'healthy observer', 'async observer']);
});

test('unregister removes an extension and invalid hooks fail fast', () => {
  const extension = { observe: () => {} };
  const pipeline = new ChatRuntimeExtensionPipeline({ extensions: [extension] });
  const unregister = pipeline.register({ beforeCommand: () => {} });
  assert.equal(unregister(), true);
  assert.equal(unregister(), false);
  assert.throws(() => pipeline.register({ beforeCommand: 'invalid' }), /hooks must be functions/);
  assert.throws(() => pipeline.register({}), /has no hooks/);
});

test('extension cleanup runs on unregister and service shutdown, with failures isolated', async () => {
  const errors = [];
  const disposed = [];
  const pipeline = new ChatRuntimeExtensionPipeline({
    onObserverError: (error) => errors.push(error.message),
    extensions: [{
      dispose: async ({ reason }) => {
        disposed.push(`async:${reason}`);
        throw new Error('async cleanup failed');
      }
    }, {
      dispose: ({ reason }) => disposed.push(`sync:${reason}`)
    }]
  });

  pipeline.close();
  await new Promise((resolve) => setImmediate(resolve));
  pipeline.close();
  assert.deepEqual(disposed, ['async:unregister', 'sync:unregister']);
  assert.deepEqual(errors, ['async cleanup failed']);
});

test('transient provider events use the same observer pipeline as durable events', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-extension-transient-'));
  const observed = [];
  const service = require('../lib/server/chat-runtime-service').createChatRuntimeService({
    storeOptions: { fs, aiHomeDir, DatabaseSync },
    extensions: [{ observe: (event, context) => observed.push([event.type, context.source]) }],
    runtimeResolver: { resolve: (provider, context) => ({ provider, runtimeScope: context.runtimeScope }) },
    driverRegistry: { resolve: () => ({ driver: { startTurn: () => Promise.resolve({}) } }) }
  });
  t.after(() => { service.close(); fs.rmSync(aiHomeDir, { recursive: true, force: true }); });
  const session = await service.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  observed.length = 0;
  service.store.appendEvent(session.sessionId, {
    type: 'session.policy.changed', source: { provider: 'codex', runtimeId: 'test' },
    payload: { patch: { title: 'x' } }
  });
  service.observeTransientEvent({ sessionId: session.sessionId, type: 'stream.error' });
  assert.deepEqual(observed, [
    ['session.policy.changed', 'runtime'],
    ['stream.error', 'runtime-transient']
  ]);
});

test('tool lifecycle hooks are awaited in registration order', async () => {
  const calls = [];
  const pipeline = new ChatRuntimeExtensionPipeline({ extensions: [
    { beforeToolCall: async () => calls.push('before-1'), afterToolCall: () => calls.push('after-1') },
    { beforeToolCall: () => calls.push('before-2'), afterToolCall: () => calls.push('after-2') }
  ] });
  const event = { type: 'timeline.item.started', payload: { item: { kind: 'tool', id: 'i1' } } };
  await pipeline.runToolHook('beforeToolCall', event);
  await pipeline.runToolHook('afterToolCall', { ...event, type: 'timeline.item.completed' });
  assert.deepEqual(calls, ['before-1', 'before-2', 'after-1', 'after-2']);
});

test('Codex canonical tool events run lifecycle hooks around durable persistence', async () => {
  const calls = [];
  const pipeline = new ChatRuntimeExtensionPipeline({ extensions: [{
    beforeToolCall: () => calls.push('before'),
    afterToolCall: () => calls.push('after')
  }] });
  const bridge = new CodexSessionEventBridge({
    extensions: pipeline,
    eventSink: (event) => { calls.push(`persist:${event.type}`); }
  });
  const context = { runId: 'run-1', turnId: 'turn-1', toolOrder: bridge.createToolOrder() };
  const result = bridge.forwardNotification({
    method: 'item/started',
    params: { turnId: 'native-turn', item: {
      type: 'commandExecution', id: 'call-1', command: 'echo ok', status: 'inProgress'
    } }
  }, context);
  await result.persisted;
  assert.deepEqual(calls, ['before', 'persist:timeline.item.started']);

  const completed = bridge.forwardNotification({
    method: 'item/completed',
    params: { turnId: 'native-turn', item: {
      type: 'commandExecution', id: 'call-1', command: 'echo ok', status: 'completed', exitCode: 0
    } }
  }, context);
  await completed.persisted;
  assert.deepEqual(calls, [
    'before', 'persist:timeline.item.started',
    'persist:timeline.item.completed', 'after'
  ]);
});

test('Codex tool policy rejection prevents persistence and propagates to the bridge', async () => {
  const expected = new Error('tool policy rejected');
  const persisted = [];
  const pipeline = new ChatRuntimeExtensionPipeline({
    extensions: [{ beforeToolCall: () => { throw expected; } }]
  });
  const bridge = new CodexSessionEventBridge({
    extensions: pipeline,
    eventSink: (event) => { persisted.push(event); }
  });
  const result = bridge.forwardNotification({
    method: 'item/started',
    params: { turnId: 'native-turn', item: {
      type: 'commandExecution', id: 'call-1', command: 'echo blocked', status: 'inProgress'
    } }
  }, { runId: 'run-1', turnId: 'turn-1' });
  await assert.rejects(result.persisted, expected);
  assert.deepEqual(persisted, []);
});

test('raw output releasing a queued typed tool still invokes the event hooks in model order', async () => {
  const calls = [];
  const bridge = new CodexSessionEventBridge({
    extensions: createChatRuntimeExtensionPipeline({ extensions: [{
      beforeToolCall: (event) => calls.push(`before:${event.payload.item.id}`)
    }] }), eventSink: (event) => calls.push(`persist:${event.payload.item.id}`)
  });
  const context = { runId: 'run-1', turnId: 'turn-1', toolOrder: bridge.createToolOrder() };
  for (const id of ['first', 'second']) await bridge.forwardNotification({ method: 'rawResponseItem/completed',
    params: { item: { id, type: 'function_call', call_id: id, name: 'exec', arguments: '{}' } } }, context).persisted;
  const queued = bridge.forwardNotification({ method: 'item/started', params: { item: {
    type: 'commandExecution', id: 'second', command: 'echo second', status: 'inProgress'
  } } }, context);
  assert.deepEqual(calls, []);
  await bridge.forwardNotification({ method: 'rawResponseItem/completed', params: { item: {
    type: 'function_call_output', call_id: 'first', output: 'done'
  } } }, context).persisted;
  await queued.persisted;
  assert.deepEqual(calls, ['before:second', 'persist:second']);
});

test('async tool event preparation cannot reorder canonical persistence', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const bridge = new CodexSessionEventBridge({
    extensions: createChatRuntimeExtensionPipeline({ extensions: [{
      beforeToolCall: (event) => event.payload.item.id === 'first' ? gate : undefined
    }] }), eventSink: (event) => seen.push(event.payload.item.id)
  });
  const send = (id) => bridge.forwardNotification({ method: 'item/started', params: { item: {
    type: 'commandExecution', id, command: 'echo test', status: 'inProgress'
  } } }, { runId: 'run-1', turnId: 'turn-1' }).persisted;
  const first = send('first');
  const second = send('second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, []);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(seen, ['first', 'second']);
});

test('SessionActor applies provider-neutral turn hooks before execution', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-extension-actor-'));
  const store = openChatRuntimeStore({ fs, aiHomeDir, DatabaseSync });
  const seen = [];
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  const actor = new SessionActor({
    sessionId: session.sessionId,
    store,
    extensions: [{
      prepareNextTurn: (command) => ({
        ...command,
        payload: { ...command.payload, content: `${command.payload.content} (prepared)` }
      }),
      observe: (event) => seen.push(event.type)
    }],
    driver: {
      startTurn: ({ command }) => {
        assert.equal(command.payload.content, 'hello (prepared)');
        return Promise.resolve({ status: 'completed' });
      }
    }
  });
  t.after(() => { actor.dispose(); store.close(); fs.rmSync(aiHomeDir, { recursive: true, force: true }); });

  await actor.dispatch({
    sessionId: session.sessionId,
    commandId: 'turn-1',
    type: 'turn.submit',
    payload: { content: 'hello' }
  });
  assert.deepEqual(seen, ['command.accepted', 'command.completed']);
  assert.equal(store.getCommand('turn-1').payload.content, 'hello (prepared)');
});

test('SessionActor preserves command idempotency when a preparation hook fails', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-extension-fail-'));
  const store = openChatRuntimeStore({ fs, aiHomeDir, DatabaseSync });
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  let preparations = 0;
  const actor = new SessionActor({
    sessionId: session.sessionId,
    store,
    extensions: [{ prepareNextTurn: () => { preparations += 1; throw new Error('policy rejected'); } }],
    driver: { startTurn: () => assert.fail('rejected preparation must not run') }
  });
  t.after(() => { actor.dispose(); store.close(); fs.rmSync(aiHomeDir, { recursive: true, force: true }); });

  await assert.rejects(actor.dispatch({
    sessionId: session.sessionId, commandId: 'turn-rejected', type: 'turn.submit',
    payload: { content: 'hello' }
  }), /policy rejected/);
  assert.equal(store.getCommand('turn-rejected').status, 'failed');
  await assert.rejects(actor.dispatch({ sessionId: session.sessionId, commandId: 'turn-rejected',
    type: 'turn.submit', payload: { content: 'hello' } }));
  assert.equal(preparations, 1, 'same failed command must not run preparation twice');
});

test('SessionActor rejects extensions that try to replace command identity', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-extension-identity-'));
  const store = openChatRuntimeStore({ fs, aiHomeDir, DatabaseSync });
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  const actor = new SessionActor({
    sessionId: session.sessionId,
    store,
    extensions: [{ prepareNextTurn: (command) => ({ ...command, commandId: 'other-command' }) }],
    driver: { startTurn: () => Promise.resolve({}) }
  });
  t.after(() => { actor.dispose(); store.close(); fs.rmSync(aiHomeDir, { recursive: true, force: true }); });

  await assert.rejects(actor.dispatch({
    sessionId: session.sessionId, commandId: 'turn-identity', type: 'turn.submit',
    payload: { content: 'hello' }
  }), (error) => error && error.code === 'chat_extension_command_identity_changed');
  assert.equal(store.getCommand('turn-identity').status, 'failed');
});

test('preparation cannot mutate identity in place, switch commands or bypass payload validation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-extension-validation-'));
  const store = openChatRuntimeStore({ fs, aiHomeDir: root, DatabaseSync });
  const session = store.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const transforms = [
    (command) => { command.commandId = 'mutated'; return command; },
    (command) => ({ ...command, type: 'turn.interrupt', payload: {} }),
    (command) => ({ ...command, payload: { content: '' } }),
    (command) => ({ ...command, payload: { content: 'ok', runId: 'client-run' } })
  ];
  for (const [index, transform] of transforms.entries()) {
    const actor = new SessionActor({ sessionId: session.sessionId, store,
      extensions: [{ prepareNextTurn: transform }], driver: { startTurn() { assert.fail('invalid command executed'); } } });
    await assert.rejects(actor.dispatch({ sessionId: session.sessionId, commandId: `invalid-${index}`,
      type: 'turn.submit', payload: { content: 'original' } }), /chat_extension_command_identity_changed|chat_turn_/);
    assert.equal(store.getCommand(`invalid-${index}`).status, 'failed');
    assert.equal(store.getCommand(`invalid-${index}`).payload.content, 'original');
    actor.dispose();
  }
  assert.equal(store.getCommand('mutated'), null);
});
