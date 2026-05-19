const test = require('node:test');
const assert = require('node:assert/strict');
const { extractRequestSessionKey } = require('../lib/server/session-key');

test('extractRequestSessionKey prefers explicit session headers', () => {
  const key = extractRequestSessionKey(
    { 'x-session-id': 'session-abc' },
    { previous_response_id: 'resp_x' }
  );
  assert.equal(key, 'session-abc');
});

test('extractRequestSessionKey falls back to previous_response_id', () => {
  const key = extractRequestSessionKey({}, { previous_response_id: 'resp_123' });
  assert.equal(key, 'resp_123');
});

test('extractRequestSessionKey returns empty string when no session signal exists', () => {
  const key = extractRequestSessionKey({}, { model: 'gpt-dynamic', messages: [] });
  assert.equal(key, '');
});
