'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { CodexUserMessageLink } = require('../lib/server/chat-runtime/codex-user-message-link');

const raw = (id, kinds = ['user.text'], turnId = 'turn') => ({ method: 'rawResponseItem/completed',
  params: { threadId: 'thread', turnId, item: { type: 'message', id, role: 'user',
    internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } } });
const typed = (id, turnId = 'turn') => ({ method: 'item/started', params: {
  threadId: 'thread', turnId, item: { id, type: 'userMessage' } } });

test('explicit user input maps once per exact stream and turn, including repeated text and images', () => {
  const link = new CodexUserMessageLink();
  link.observe(raw('environment', ['environments.environment_context']));
  assert.equal(link.observe(typed('context')), null);
  link.observe(raw('first', ['user.text', 'user.image']));
  link.observe(raw('other', ['user.text'], 'other-turn'));
  assert.equal(link.observe(typed('ui-first')), 'first');
  assert.equal(link.observe(typed('duplicate')), null);
  assert.equal(link.observe(typed('ui-other', 'other-turn')), 'other');
  link.observe(raw('second'));
  assert.equal(link.observe(typed('ui-second')), 'second');
});

test('ambiguous candidates, intervening items and reconnect gaps never guess a mapping', () => {
  const link = new CodexUserMessageLink();
  link.observe(raw('a'));
  link.observe(raw('b'));
  assert.equal(link.observe(typed('ambiguous')), null);
  link.observe(raw('a'));
  link.observe({ ...raw('tool'), params: { ...raw('tool').params, item: { id: 'tool', type: 'function_call' } } });
  assert.equal(link.observe(typed('interleaved')), null);
  link.observe(raw('a'));
  link.reset('thread', 'turn');
  assert.equal(link.observe(typed('recovered')), null);
  link.observe(raw('a', ['unknown']));
  assert.equal(link.observe(typed('no-provenance')), null);
});
