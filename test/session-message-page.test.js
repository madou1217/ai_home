'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_SESSION_MESSAGE_PAGE_BYTES,
  buildSessionMessagePage
} = require('../lib/server/session-message-page');

function createMessages(count, contentFactory = (index) => `message-${index}`) {
  return Array.from({ length: count }, (_item, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: contentFactory(index),
    timestamp: index
  }));
}

test('buildSessionMessagePage pages backward from an exclusive before index', () => {
  const page = buildSessionMessagePage(
    createMessages(75),
    new URLSearchParams({ before: '25', limit: '10' })
  );

  assert.equal(page.start, 15);
  assert.equal(page.total, 75);
  assert.equal(page.hasMore, true);
  assert.deepEqual(
    page.messages.map((message) => message.content),
    Array.from({ length: 10 }, (_item, index) => `message-${index + 15}`)
  );

  const clamped = buildSessionMessagePage(createMessages(75), {
    before: 999,
    limit: 999
  });
  assert.equal(clamped.start, 25);
  assert.equal(clamped.messages.length, 50);
});

test('buildSessionMessagePage shrinks a 50-message page to the JSON byte budget', () => {
  const messages = createMessages(
    50,
    (index) => `message-${index}:${'x'.repeat(128 * 1024)}`
  );

  const page = buildSessionMessagePage(messages, { limit: 50 });
  const pageBytes = Buffer.byteLength(JSON.stringify(page.messages), 'utf8');

  assert.ok(page.messages.length > 1);
  assert.ok(page.messages.length < 50);
  assert.ok(pageBytes <= MAX_SESSION_MESSAGE_PAGE_BYTES);
  assert.equal(page.start, 50 - page.messages.length);
  assert.equal(page.total, 50);
  assert.equal(page.hasMore, true);
  assert.match(page.messages[0].content, new RegExp(`^message-${page.start}:`));
});

test('buildSessionMessagePage returns one nine-MiB message without truncating it', () => {
  const content = 'x'.repeat(9 * 1024 * 1024);
  const page = buildSessionMessagePage([
    { role: 'assistant', content, timestamp: 1 }
  ]);

  assert.equal(page.start, 0);
  assert.equal(page.total, 1);
  assert.equal(page.hasMore, false);
  assert.equal(page.messages.length, 1);
  assert.equal(page.messages[0].content, content);
  assert.ok(Buffer.byteLength(JSON.stringify(page.messages), 'utf8') > MAX_SESSION_MESSAGE_PAGE_BYTES);
});
