'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopChatRuntimeBridge } = require('../lib/desktop/chat/chat-runtime-bridge');

function runtimeFixture({ synchronousTurnEvent = false } = {}) {
  const listeners = new Map();
  const calls = [];
  const session = { sessionId: 'session-1', provider: 'codex', executionAccountRef: 'gateway', policy: { model: 'gpt-6.1-sol' } };
  const event = (type, seq, payload = {}) => ({
    schema: 'aih.chat.event.v1', eventId: `event-${seq}`, sessionId: session.sessionId,
    seq, type, at: seq, source: { provider: 'codex', runtimeId: 'runtime-1' }, payload
  });
  return {
    calls,
    runtime: {
      async openChatSession(input) { calls.push(['open', input]); return session; },
      subscribe(sessionId, listener) { listeners.set(sessionId, listener); return () => listeners.delete(sessionId); },
      async readEvents() { return { events: [event('session.created', 1, { state: 'idle' })] }; },
      async dispatchCommand(sessionId, command) {
        calls.push(['dispatch', sessionId, command]);
        if (synchronousTurnEvent && command.type === 'turn.submit') listeners.get(session.sessionId)?.(event('turn.started', 2, { turnId: 'turn-sync' }));
        return { sessionId, commandId: command.commandId, acceptedSeq: calls.filter((call) => call[0] === 'dispatch').length + 1, duplicate: false };
      },
      emit(type, payload, seq = 3) { listeners.get(session.sessionId)?.(event(type, seq, payload)); }
    }
  };
}

test('desktop Chat bridge opens a runtime session and forwards canonical events', async () => {
  const fixture = runtimeFixture();
  const outgoing = [];
  const bridge = createDesktopChatRuntimeBridge({
    runtime: fixture.runtime,
    resolveTarget: () => ({ provider: 'codex', model: 'gpt-6.1-sol', executionAccountRef: 'gateway' })
  });
  await bridge.handle({ type: 'chat.open', requestId: 'request-1', generation: 4, target: { kind: 'aih-server' } }, { send: (event) => outgoing.push(event) });
  assert.deepEqual(fixture.calls[0][0], 'open');
  assert.equal(outgoing[0].type, 'chat.event');
  assert.equal(outgoing[0].event.type, 'session.created');
  assert.equal(outgoing[0].generation, undefined);
});

test('desktop Chat bridge binds submit and stop to caller command identity and generation', async () => {
  const fixture = runtimeFixture();
  const outgoing = [];
  const bridge = createDesktopChatRuntimeBridge({
    runtime: fixture.runtime,
    resolveTarget: () => ({ provider: 'codex', model: 'gpt-6.1-sol', executionAccountRef: 'gateway' })
  });
  const send = (event) => outgoing.push(event);
  await bridge.handle({ type: 'chat.open', requestId: 'request-1', generation: 1, target: {} }, { send });
  await bridge.handle({ type: 'chat.submit', requestId: 'request-1', sessionId: 'session-1', commandId: 'command-1', generation: 2, text: 'hello' }, { send });
  fixture.runtime.emit('turn.started', { turnId: 'turn-1' });
  await bridge.handle({ type: 'chat.stop', requestId: 'request-1', sessionId: 'session-1', commandId: 'command-1', generation: 2 }, { send });
  assert.deepEqual(fixture.calls.filter((call) => call[0] === 'dispatch').map((call) => call[2]), [
    { commandId: 'command-1', type: 'turn.submit', payload: { content: 'hello', model: 'gpt-6.1-sol' } },
    { commandId: 'command-1:interrupt', type: 'turn.interrupt', payload: { reason: 'user_stop' } }
  ]);
  const turn = outgoing.find((event) => event.event && event.event.type === 'turn.started');
  assert.equal(turn.commandId, 'command-1');
  assert.equal(turn.generation, 2);
});

test('desktop Chat bridge projects runtime failures with request/session/command identity', async () => {
  const fixture = runtimeFixture();
  const outgoing = [];
  const bridge = createDesktopChatRuntimeBridge({ runtime: fixture.runtime, resolveTarget: () => ({ provider: 'codex', model: 'm', executionAccountRef: 'gateway' }) });
  const send = (event) => outgoing.push(event);
  await bridge.handle({ type: 'chat.open', requestId: 'request-1', target: {} }, { send });
  await bridge.handle({ type: 'chat.submit', requestId: 'request-1', sessionId: 'session-1', commandId: 'command-1', generation: 1, text: 'hello' }, { send });
  await bridge.handle({ type: 'chat.stop', requestId: 'request-1', sessionId: 'wrong', commandId: 'command-1', generation: 1 }, { send });
  const error = outgoing.find((event) => event.type === 'chat.error');
  assert.equal(error.requestId, 'request-1');
  assert.equal(error.sessionId, 'wrong');
  assert.equal(error.commandId, 'command-1');
});

test('desktop Chat bridge does not tag stale sequence events with a newer command', async () => {
  const fixture = runtimeFixture();
  const outgoing = [];
  const bridge = createDesktopChatRuntimeBridge({ runtime: fixture.runtime, resolveTarget: () => ({ provider: 'codex', model: 'm', executionAccountRef: 'gateway' }) });
  const send = (event) => outgoing.push(event);
  await bridge.handle({ type: 'chat.open', requestId: 'request-1', target: {} }, { send });
  await bridge.handle({ type: 'chat.submit', requestId: 'request-1', sessionId: 'session-1', commandId: 'command-1', generation: 1, text: 'one' }, { send });
  fixture.runtime.emit('turn.started', { turnId: 'turn-old' }, 3);
  await bridge.handle({ type: 'chat.submit', requestId: 'request-1', sessionId: 'session-1', commandId: 'command-2', generation: 2, text: 'two' }, { send });
  fixture.runtime.emit('timeline.item.delta', { itemId: 'old', chunk: 'old' }, 2);
  const latest = outgoing.filter((event) => event.event && event.event.type === 'timeline.item.delta').at(-1);
  assert.equal(latest.commandId, undefined);
  assert.equal(latest.generation, undefined);
});

test('desktop Chat bridge tags synchronously emitted turn events with the provisional command identity', async () => {
  const fixture = runtimeFixture({ synchronousTurnEvent: true });
  const outgoing = [];
  const bridge = createDesktopChatRuntimeBridge({ runtime: fixture.runtime, resolveTarget: () => ({ provider: 'codex', model: 'm', executionAccountRef: 'gateway' }) });
  const send = (event) => outgoing.push(event);
  await bridge.handle({ type: 'chat.open', requestId: 'request-1', target: {} }, { send });
  await bridge.handle({ type: 'chat.submit', requestId: 'request-1', sessionId: 'session-1', commandId: 'command-1', generation: 1, text: 'hello' }, { send });
  const turn = outgoing.find((event) => event.event && event.event.type === 'turn.started');
  assert.equal(turn.commandId, 'command-1');
  assert.equal(turn.generation, 1);
});

test('desktop Chat bridge tags active stream errors with command identity', async () => {
  const fixture = runtimeFixture();
  const outgoing = [];
  const bridge = createDesktopChatRuntimeBridge({ runtime: fixture.runtime, resolveTarget: () => ({ provider: 'codex', model: 'm', executionAccountRef: 'gateway' }) });
  const send = (event) => outgoing.push(event);
  await bridge.handle({ type: 'chat.open', requestId: 'request-1', target: {} }, { send });
  await bridge.handle({ type: 'chat.submit', requestId: 'request-1', sessionId: 'session-1', commandId: 'command-1', generation: 1, text: 'hello' }, { send });
  fixture.runtime.emit('stream.error', { error: 'stream_failed' }, 0);
  const error = outgoing.find((event) => event.event && event.event.type === 'stream.error');
  assert.equal(error.commandId, 'command-1');
  assert.equal(error.generation, 1);
});

test('desktop Chat bridge unsubscribes on close', async () => {
  const fixture = runtimeFixture();
  const outgoing = [];
  const bridge = createDesktopChatRuntimeBridge({ runtime: fixture.runtime, resolveTarget: () => ({ provider: 'codex', model: 'm', executionAccountRef: 'gateway' }) });
  const send = (event) => outgoing.push(event);
  await bridge.handle({ type: 'chat.open', requestId: 'request-1', target: {} }, { send });
  await bridge.handle({ type: 'chat.close', requestId: 'request-1' }, { send });
  const before = outgoing.length;
  fixture.runtime.emit('turn.started', {});
  assert.equal(outgoing.length, before);
});
