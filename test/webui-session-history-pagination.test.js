'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  handleGetSessionMessagesRequest
} = require('../lib/server/webui-session-routes');

function createMessages(count) {
  return Array.from({ length: count }, (_item, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}`,
    timestamp: index
  }));
}

async function requestMessages(query = '') {
  const writes = [];
  const messages = createMessages(75);
  const handled = await handleGetSessionMessagesRequest({
    pathname: '/v0/webui/sessions/codex/session-1/messages',
    req: {
      headers: { host: '127.0.0.1:9527' },
      url: `/v0/webui/sessions/codex/session-1/messages${query}`
    },
    res: {},
    deps: {
      readSessionMessagesSnapshot: () => ({ messages, cursor: 987 })
    },
    writeJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    }
  });
  assert.equal(handled, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].statusCode, 200);
  return writes[0].payload;
}

async function requestCustomMessages(messages, query = '') {
  const writes = [];
  await handleGetSessionMessagesRequest({
    pathname: '/v0/webui/sessions/codex/session-1/messages',
    req: {
      headers: { host: '127.0.0.1:9527' },
      url: `/v0/webui/sessions/codex/session-1/messages${query}`
    },
    res: {},
    deps: {
      readSessionMessagesSnapshot: () => ({ messages, cursor: 987 })
    },
    writeJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    }
  });
  assert.equal(writes[0].statusCode, 200);
  return writes[0].payload;
}

test('session messages route returns a bounded tail page by default', async () => {
  const payload = await requestMessages();

  assert.equal(payload.cursor, 987);
  assert.equal(payload.start, 25);
  assert.equal(payload.total, 75);
  assert.equal(payload.hasMore, true);
  assert.equal(payload.messages.length, 50);
  assert.equal(payload.messages[0].content, 'message-25');
  assert.equal(payload.messages.at(-1).content, 'message-74');
});

test('session messages route pages backward with an exclusive before index', async () => {
  const payload = await requestMessages('?before=25&limit=10');

  assert.equal(payload.cursor, 987);
  assert.equal(payload.start, 15);
  assert.equal(payload.total, 75);
  assert.equal(payload.hasMore, true);
  assert.deepEqual(
    payload.messages.map((message) => message.content),
    createMessages(25).slice(15, 25).map((message) => message.content)
  );
});

test('session messages route clamps page limits and the before index', async () => {
  const payload = await requestMessages('?before=999&limit=999');

  assert.equal(payload.start, 25);
  assert.equal(payload.total, 75);
  assert.equal(payload.messages.length, 50);
  assert.equal(payload.messages.at(-1).content, 'message-74');
});

test('session messages route shrinks a 50-message page to its byte budget', async () => {
  const messages = createMessages(50).map((message) => ({
    ...message,
    content: `${message.content}:${'x'.repeat(128 * 1024)}`
  }));

  const payload = await requestCustomMessages(messages, '?limit=50');
  const returnedBytes = Buffer.byteLength(JSON.stringify(payload.messages), 'utf8');

  assert.ok(payload.messages.length > 1);
  assert.ok(payload.messages.length < 50);
  assert.ok(returnedBytes <= 4 * 1024 * 1024 + payload.messages.length);
  assert.equal(payload.start, 50 - payload.messages.length);
  assert.equal(payload.total, 50);
  assert.equal(payload.hasMore, true);
  assert.match(payload.messages[0].content, new RegExp(`^message-${payload.start}:`));
});

test('session messages route returns one oversized message without truncating content', async () => {
  const content = '九'.repeat(3 * 1024 * 1024);
  assert.ok(Buffer.byteLength(content, 'utf8') > 8 * 1024 * 1024);

  const payload = await requestCustomMessages([
    { role: 'assistant', content, timestamp: 1 }
  ]);

  assert.equal(payload.start, 0);
  assert.equal(payload.total, 1);
  assert.equal(payload.hasMore, false);
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0].content, content);
});

test('session messages route uses one atomic messages and cursor snapshot', async () => {
  const writes = [];
  const messages = createMessages(2);
  let snapshotCalls = 0;

  await handleGetSessionMessagesRequest({
    pathname: '/v0/webui/sessions/codex/session-1/messages',
    req: {
      headers: { host: '127.0.0.1:9527' },
      url: '/v0/webui/sessions/codex/session-1/messages'
    },
    res: {},
    deps: {
      readSessionMessagesSnapshot: () => {
        snapshotCalls += 1;
        return { messages, cursor: 321 };
      }
    },
    writeJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    }
  });

  assert.equal(snapshotCalls, 1);
  assert.equal(writes[0].payload.cursor, 321);
  assert.equal(writes[0].payload.messages.length, 2);
  assert.equal(writes[0].payload.messages.at(-1).content, 'message-1');
});

test('session messages route retries one transient transcript read failure', async () => {
  const writes = [];
  let snapshotCalls = 0;

  await handleGetSessionMessagesRequest({
    pathname: '/v0/webui/sessions/codex/session-1/messages',
    req: {
      headers: { host: '127.0.0.1:9527' },
      url: '/v0/webui/sessions/codex/session-1/messages'
    },
    res: {},
    deps: {
      readSessionMessagesSnapshot: () => {
        snapshotCalls += 1;
        if (snapshotCalls === 1) throw new Error('transient_read_failure');
        return { messages: createMessages(1), cursor: 123 };
      }
    },
    writeJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    }
  });

  assert.equal(snapshotCalls, 2);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].statusCode, 200);
  assert.equal(writes[0].payload.messages[0].content, 'message-0');
});

test('session messages route reports repeated transcript read failures', async () => {
  const writes = [];
  let snapshotCalls = 0;

  await handleGetSessionMessagesRequest({
    pathname: '/v0/webui/sessions/codex/session-1/messages',
    req: {
      headers: { host: '127.0.0.1:9527' },
      url: '/v0/webui/sessions/codex/session-1/messages'
    },
    res: {},
    deps: {
      readSessionMessagesSnapshot: () => {
        snapshotCalls += 1;
        throw new Error('persistent_read_failure');
      }
    },
    writeJson(_res, statusCode, payload) {
      writes.push({ statusCode, payload });
    }
  });

  assert.equal(snapshotCalls, 2);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].statusCode, 500);
  assert.equal(writes[0].payload.error, 'get_messages_failed');
  assert.equal(writes[0].payload.message, 'persistent_read_failure');
});
