'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDesktopChatRuntimeClient,
  DesktopChatRuntimeError
} = require('../lib/desktop/chat/chat-runtime-client');
const {
  encodeChatMessage,
  decodeChatLine,
  createChatJsonlParser,
  chatSubmit,
  chatError
} = require('../lib/desktop/chat/chat-runtime-protocol');

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}

function session() {
  return {
    sessionId: 'session-1', provider: 'codex', executionAccountRef: 'account-1',
    projectPath: '', state: 'idle', lastEventSeq: 0, createdAt: 1, updatedAt: 1,
    policy: {}, runtimeBinding: {}, capabilitySnapshot: {}
  };
}

function runtimeEvent(overrides = {}) {
  return {
    schema: 'aih.chat.event.v1', eventId: 'event-1', sessionId: 'session-1', seq: 8,
    type: 'turn.started', at: 10,
    source: { provider: 'codex', runtimeId: 'runtime-1' }, payload: {}, ...overrides
  };
}

test('creates a Chat Runtime session through the canonical endpoint', async () => {
  const calls = [];
  const client = createDesktopChatRuntimeClient({
    idFactory: () => 'request-1',
    fetch: async (path, init) => {
      calls.push({ path, init });
      return response({ ok: true, session: session() }, 201);
    },
    openEvents: () => { throw new Error('not expected'); }
  });

  const result = await client.createSession({
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/tmp/project'
  });
  assert.equal(result.sessionId, 'session-1');
  assert.equal(calls[0].path, '/v0/webui/chat/sessions');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    provider: 'codex', executionAccountRef: 'account-1', projectPath: '/tmp/project'
  });
});

test('replays events from the supplied cursor and ignores stale session or sequence events', () => {
  const stream = {};
  let openedPath;
  const received = [];
  const client = createDesktopChatRuntimeClient({
    idFactory: () => 'request-events',
    fetch: async () => response({ ok: true }),
    openEvents: (path) => { openedPath = path; return stream; }
  });

  const started = client.start('session-1', 7);
  started.onEvent((event) => received.push(event));
  stream.onmessage({ data: JSON.stringify(runtimeEvent({ sessionId: 'other' })) });
  stream.onmessage({ data: JSON.stringify(runtimeEvent({ seq: 7 })) });
  stream.onmessage({ data: JSON.stringify(runtimeEvent()) });

  assert.equal(openedPath, '/v0/webui/chat/sessions/session-1/events?after=7');
  assert.equal(received.length, 1);
  assert.equal(received[0].seq, 8);
  assert.equal(started.cursor, 8);
});

test('rejects malformed event sequence values before they reach listeners', () => {
  const stream = {};
  const received = [];
  const client = createDesktopChatRuntimeClient({
    idFactory: () => 'request-events',
    fetch: async () => response({ ok: true }),
    openEvents: () => stream
  });
  const started = client.start('session-1', 7);
  started.onEvent((event) => received.push(event));
  for (const seq of [undefined, 0, -1, 1.5, '8']) {
    stream.onmessage({ data: JSON.stringify(runtimeEvent({ seq })) });
  }
  assert.deepEqual(received, []);
  assert.equal(started.cursor, 7);
});

test('validates canonical event envelopes and allows sequence zero only for transport events', () => {
  const stream = {};
  const received = [];
  const errors = [];
  const client = createDesktopChatRuntimeClient({
    idFactory: () => 'request-events', fetch: async () => response({ ok: true }), openEvents: () => stream
  });
  const started = client.start('session-1', 0);
  started.onEvent((event) => received.push(event)).onError((error) => errors.push(error.code));
  stream.onmessage({ data: JSON.stringify({ ...runtimeEvent(), schema: 'wrong' }) });
  stream.onmessage({ data: JSON.stringify({ ...runtimeEvent(), type: 'unknown.event' }) });
  stream.onmessage({ data: JSON.stringify({ ...runtimeEvent(), payload: null }) });
  stream.onmessage({ data: JSON.stringify(runtimeEvent({ type: 'stream.error', seq: 0, payload: { error: 'failed', message: 'retry' } })) });
  stream.onmessage({ data: JSON.stringify(runtimeEvent({ type: 'session.snapshot.reset', seq: 0, payload: { throughSeq: 0 } })) });
  stream.onmessage({ data: JSON.stringify(runtimeEvent({ type: 'turn.started', seq: 0 })) });
  assert.deepEqual(received.map((event) => [event.type, event.seq]), [
    ['stream.error', 0], ['session.snapshot.reset', 0]
  ]);
  assert.equal(started.cursor, 0);
  assert.deepEqual(errors, [
    'chat_runtime_event_schema_invalid', 'chat_runtime_event_type_invalid', 'chat_runtime_event_payload_invalid',
    'chat_runtime_event_seq_invalid'
  ]);
});

test('rejects sessions with invalid state, timestamps, or DTO record shapes', async () => {
  for (const [field, value, code] of [
    ['state', 'bogus', 'chat_runtime_state_invalid'],
    ['lastEventSeq', -1, 'chat_runtime_session_seq_invalid'],
    ['createdAt', 'yesterday', 'chat_runtime_session_created_at_invalid'],
    ['updatedAt', null, 'chat_runtime_session_updated_at_invalid'],
    ['policy', null, 'chat_runtime_session_policy_invalid'],
    ['runtimeBinding', [], 'chat_runtime_session_binding_invalid'],
    ['capabilitySnapshot', 'invalid', 'chat_runtime_capabilities_invalid']
  ]) {
    const invalid = { ...session(), [field]: value };
    const client = createDesktopChatRuntimeClient({
      fetch: async () => response({ ok: true, session: invalid }),
      openEvents: () => ({ close() {} })
    });
    await assert.rejects(client.createSession({ provider: 'codex', executionAccountRef: 'account-1' }),
      (error) => error instanceof DesktopChatRuntimeError && error.code === code);
  }
});

test('validates capability snapshot fields, nested names, descriptors, and valid snapshots', async () => {
  const invalidSnapshots = [
    { bogus: true },
    { capabilities: { bogus: { support: 'native' } } },
    { capabilities: { 'turn.interrupt': { support: 'bogus' } } },
    { capabilities: { 'turn.interrupt': { support: 'native', bogus: true } } },
    { slashCommands: ['ok', 1] }
  ];
  for (const capabilitySnapshot of invalidSnapshots) {
    const client = createDesktopChatRuntimeClient({
      fetch: async () => response({ ok: true, session: { ...session(), capabilitySnapshot } }),
      openEvents: () => ({ close() {} })
    });
    await assert.rejects(client.createSession({ provider: 'codex', executionAccountRef: 'account-1' }),
      (error) => error instanceof DesktopChatRuntimeError && error.code.startsWith('chat_runtime_capabilit'));
  }
  const validSnapshot = {
    revision: 'v1', capturedAt: 12,
    capabilities: { 'turn.interrupt': { support: 'native', alternatives: ['queue.add'] } },
    slashCommands: ['/compact'], turnInterveneModes: ['steer_current']
  };
  const client = createDesktopChatRuntimeClient({
    fetch: async () => response({ ok: true, session: { ...session(), capabilitySnapshot: validSnapshot } }),
    openEvents: () => ({ close() {} })
  });
  const result = await client.createSession({ provider: 'codex', executionAccountRef: 'account-1' });
  assert.deepEqual(result.capabilitySnapshot, validSnapshot);
});

test('uses caller command id for idempotent submit and stop commands', async () => {
  const bodies = [];
  const client = createDesktopChatRuntimeClient({
    idFactory: () => 'generated-id',
    fetch: async (_path, init) => {
      bodies.push(JSON.parse(init.body));
      return response({ ok: true, sessionId: 'session-1', commandId: bodies.at(-1).commandId,
        acceptedSeq: bodies.length, duplicate: bodies.length > 1 });
    },
    openEvents: () => ({ close() {} })
  });

  const first = await client.sendTurn('session-1', 'hello', { commandId: 'turn-1' });
  const second = await client.sendTurn('session-1', 'hello', { commandId: 'turn-1' });
  const stopped = await client.stopTurn('session-1', 'stop-1');
  assert.equal(first.commandId, 'turn-1');
  assert.equal(second.duplicate, true);
  assert.equal(stopped.commandId, 'stop-1');
  assert.equal(bodies[0].type, 'turn.submit');
  assert.deepEqual(bodies[0].payload, { content: 'hello' });
  assert.equal(bodies[2].type, 'turn.interrupt');
});

test('normalizes HTTP runtime failures without exposing request payloads', async () => {
  const client = createDesktopChatRuntimeClient({
    fetch: async () => response({ ok: false, error: 'chat_turn_content_required', message: 'bad input', details: { field: 'content' } }, 422),
    openEvents: () => ({ close() {} })
  });

  await assert.rejects(
    client.sendTurn('session-1', 'secret prompt'),
    (error) => error instanceof DesktopChatRuntimeError
      && error.code === 'chat_turn_content_required'
      && error.statusCode === 422
      && error.details.field === 'content'
      && !String(error.message).includes('secret prompt')
  );
});

test('projects the helper protocol as strict JSONL and preserves request identity', () => {
  const line = encodeChatMessage({
    type: 'chat.submit', requestId: 'request-1', sessionId: 'session-1', commandId: 'turn-1',
    text: 'hello'
  });
  assert.equal(line.endsWith('\n'), true);
  assert.deepEqual(decodeChatLine(line), {
    type: 'chat.submit', requestId: 'request-1', sessionId: 'session-1', commandId: 'turn-1',
    text: 'hello'
  });

  const parser = createChatJsonlParser();
  const parsed = [];
  parser.onMessage((message) => parsed.push(message));
  parser.push('{"type":"chat.event","requestId":"r","sessionId":"s","event":{"seq":1}}\n');
  parser.end();
  assert.deepEqual(parsed, [{
    type: 'chat.event', requestId: 'r', sessionId: 's', event: { seq: 1 }
  }]);
});

test('protocol constructors preserve canonical identity fields over caller extras', () => {
  const submit = decodeChatLine(encodeChatMessage(chatSubmit('request-1', 'session-1', 'turn-1', 'hello', {
    type: 'wrong', requestId: 'wrong', sessionId: 'wrong', commandId: 'wrong'
  })));
  assert.deepEqual(submit, {
    type: 'chat.submit', requestId: 'request-1', sessionId: 'session-1', commandId: 'turn-1', text: 'hello'
  });
  const error = decodeChatLine(encodeChatMessage(chatError('request-1', 'runtime_failed', 'safe', {
    type: 'wrong', requestId: 'wrong', code: 'wrong', sessionId: 'session-1'
  })));
  assert.deepEqual(error, {
    type: 'chat.error', requestId: 'request-1', code: 'runtime_failed', message: 'safe', sessionId: 'session-1'
  });
});
