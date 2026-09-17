'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { transformJsonStrings } = require('../lib/cli/services/account/rekey-json');
const { classifyDatabaseText } = require('../lib/cli/services/account/codex-rekey-reference-policy');
const oldRef = 'acct_aaaaaaaaaaaaaaaaaaaa';
const newRef = 'acct_bbbbbbbbbbbbbbbbbbbb';
const mapping = new Map([[oldRef, newRef]]);

test('rekey preserves unsafe integer literals, exponents, whitespace and every untouched byte', () => {
  const input = ` { "accountRef" : "${oldRef}", "n":9223372036854775807, "x":1e999, "s":"\\u0078" } `;
  const result = transformJsonStrings(input, value => mapping.get(value) || value);
  assert.equal(result.text, input.replace(oldRef, newRef));
  assert.equal(result.replacements, 1);
});

test('rekey rejects duplicate decoded keys and collisions created by renaming', () => {
  assert.throws(() => transformJsonStrings('{"key":1,"k\\u0065y":2}', value => value), /key_collision/);
  assert.throws(() => transformJsonStrings(`{"${oldRef}":1,"${newRef}":2}`, value => mapping.get(value) || value), /key_collision/);
});

for (const raw of ['[1,]', '{"x":01}', '{"x":true}{}', '{"x":undefined}', '"unclosed', '1e', 'NaN']) {
  test(`invalid migration JSON is rejected: ${raw}`, () => {
    assert.throws(() => transformJsonStrings(raw, value => value), /json_invalid/);
  });
}

test('chat text and tool output remain immutable while typed machine paths move', () => {
  const raw = `{"accountRef":"${oldRef}","runtimeDir":"/aih/run/chat-harness/${oldRef}","content":"explain ${oldRef}","n":9223372036854775807}`;
  const result = classifyDatabaseText('chat_runtime_events', 'payload_json', raw, mapping);
  assert.equal(result.kind, 'rewrite');
  assert.ok(result.value.includes(`"content":"explain ${oldRef}"`));
  assert.ok(result.value.includes(`"runtimeDir":"/aih/run/chat-harness/${newRef}"`));
  assert.ok(result.value.includes('9223372036854775807'));
});

test('usage event deduplication key is immutable and unknown embedded refs block', () => {
  assert.equal(classifyDatabaseText('model_usage_records', 'event_key', `gateway:${oldRef}:r1`, mapping).kind, 'immutable');
  assert.equal(classifyDatabaseText('chat_runtime_sessions', 'runtime_binding_json', `{"unknown":"scope:${oldRef}"}`, mapping).kind, 'unknown');
});

test('compact app-server socket names are typed runtime references, not invisible stale aliases', () => {
  const value = `{"socket":"aih-codexapp-${oldRef.replace('_', '')}"}`;
  const result = classifyDatabaseText('chat_runtime_sessions', 'runtime_binding_json', value, mapping);
  assert.equal(result.kind, 'rewrite');
  assert.equal(result.value, `{"socket":"aih-codexapp-${newRef.replace('_', '')}"}`);
});

test('persisted display errors and tool arguments keep historical evidence while adjacent routing facts migrate', () => {
  const error = JSON.stringify({ error: `request for ${oldRef} failed`, accountRef: oldRef });
  const planned = classifyDatabaseText('app_kv', 'value', error, mapping);
  assert.equal(planned.kind, 'rewrite');
  assert.deepEqual(JSON.parse(planned.value), { error: `request for ${oldRef} failed`, accountRef: newRef });
  const tool = JSON.stringify({ item: { arguments: JSON.stringify({ command: `inspect ${oldRef}` }) }, executionAccountRef: oldRef });
  const event = classifyDatabaseText('chat_runtime_events', 'payload_json', tool, mapping);
  assert.equal(event.kind, 'rewrite');
  assert.deepEqual(JSON.parse(event.value).item, JSON.parse(tool).item);
});

test('recorded shell command text remains unchanged, but an untyped future launch command still blocks', () => {
  const value = JSON.stringify({ item: { kind: 'shell', detail: { command: `cat /aih/run/${oldRef}/config` } }, accountRef: oldRef });
  const historical = classifyDatabaseText('chat_runtime_events', 'payload_json', value, mapping);
  assert.equal(historical.kind, 'rewrite');
  assert.equal(JSON.parse(historical.value).item.detail.command, `cat /aih/run/${oldRef}/config`);
  const future = classifyDatabaseText('app_kv', 'value', JSON.stringify({ command: `cat /aih/run/${oldRef}/config` }), mapping);
  assert.equal(future.kind, 'unknown');
});
