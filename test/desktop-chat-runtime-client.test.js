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
  createChatJsonlParser
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
  stream.onmessage({ data: JSON.stringify({ sessionId: 'other', seq: 8, type: 'turn.started' }) });
  stream.onmessage({ data: JSON.stringify({ sessionId: 'session-1', seq: 7, type: 'turn.started' }) });
  stream.onmessage({ data: JSON.stringify({ sessionId: 'session-1', seq: 8, type: 'turn.started' }) });

  assert.equal(openedPath, '/v0/webui/chat/sessions/session-1/events?after=7');
  assert.equal(received.length, 1);
  assert.equal(received[0].seq, 8);
  assert.equal(started.cursor, 8);
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
