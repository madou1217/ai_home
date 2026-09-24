'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyRoute,
  compileRouteTable,
  loadRouteOwnershipManifest,
  resolveGoOwnedEntryIds
} = require('../lib/server/go-core-route-ownership');

const manifest = loadRouteOwnershipManifest();
const table = compileRouteTable(manifest);

test('classifyRoute maps every data-plane path to its manifest entry', () => {
  const cases = [
    ['GET', '/v1/models', 'gateway.models.list'],
    ['GET', '/v1/models/claude-sonnet-4', 'gateway.models.detail'],
    ['POST', '/v1/messages', 'gateway.anthropic.messages'],
    ['POST', '/v1/messages/count_tokens', 'gateway.anthropic.count_tokens'],
    ['POST', '/v1/chat/completions', 'gateway.openai.chat_completions'],
    ['POST', '/v1/responses', 'gateway.openai.responses'],
    ['POST', '/v1beta/models/gemini-2.5-pro:generateContent', 'gateway.gemini.generate_content'],
    ['POST', '/v1/models/gemini-2.5-pro:streamGenerateContent', 'gateway.gemini.stream_generate_content'],
    ['GET', '/v1/blobs/abc123', 'gateway.vision.blobs']
  ];
  for (const [method, pathname, expected] of cases) {
    assert.equal(classifyRoute(table, { method, pathname }), expected, `${method} ${pathname}`);
  }
});

test('classifyRoute prefers the most specific template and applies Node path normalization', () => {
  // `/v1/models/{id}` 不得吞掉 Gemini 的 `:generateContent`。
  assert.equal(
    classifyRoute(table, { method: 'POST', pathname: '/v1/models/x:generateContent' }),
    'gateway.gemini.generate_content'
  );
  assert.equal(classifyRoute(table, { method: 'POST', pathname: '/v1/v1/messages' }), 'gateway.anthropic.messages');
  assert.equal(classifyRoute(table, { transport: 'websocket', pathname: '/v1/responses' }), 'gateway.openai.responses.websocket');
  assert.equal(classifyRoute(table, { method: 'DELETE', pathname: '/v1/messages' }), '');
  assert.equal(classifyRoute(table, { method: 'GET', pathname: '/v1/unknown' }), '');
});

test('the checked-in manifest assigns nothing to Go, so the default forwards nothing', () => {
  const resolved = resolveGoOwnedEntryIds(manifest, []);
  assert.equal(resolved.entryIds.size, 0);
  assert.deepEqual(resolved.errors, []);
});

test('operator canary accepts data-plane entries that have a Go implementation', () => {
  const resolved = resolveGoOwnedEntryIds(manifest, 'gateway.models.detail, gateway.anthropic.messages');
  assert.deepEqual([...resolved.entryIds].sort(), ['gateway.anthropic.messages', 'gateway.models.detail']);
  assert.deepEqual(resolved.canaryIds, ['gateway.models.detail', 'gateway.anthropic.messages']);
  assert.deepEqual(resolved.errors, []);
});

test('an invalid canary is rejected as a whole instead of partially applied', () => {
  for (const [requested, message] of [
    [['gateway.models.list', 'gateway.nope'], /unknown route entry: gateway\.nope/],
    [['gateway.readiness'], /owned by the Node host/],
    [['node.fabric_surface'], /owned by the Node host/],
    [['gateway.openai.responses'], /must move together/]
  ]) {
    const resolved = resolveGoOwnedEntryIds(manifest, requested);
    assert.equal(resolved.entryIds.size, 0, String(requested));
    assert.match(resolved.errors.join('\n'), message);
  }
  const paired = resolveGoOwnedEntryIds(manifest, ['gateway.openai.responses', 'gateway.openai.responses.websocket']);
  assert.deepEqual(paired.errors, []);
  assert.equal(paired.entryIds.size, 2);
});

test('entries formally marked go_owned are forwarded without an operator canary', () => {
  const promoted = {
    entries: manifest.entries.map((entry) => (entry.id === 'gateway.props'
      ? { ...entry, production_owner: 'go', migration_state: 'go_owned' }
      : entry))
  };
  assert.deepEqual([...resolveGoOwnedEntryIds(promoted, []).entryIds], ['gateway.props']);
});

test('the model catalog moves to Go only after every inference route', () => {
  const { CATALOG_ENTRY_ID, INFERENCE_ENTRY_IDS } = require('../lib/server/go-core-route-ownership');
  const manifest = loadRouteOwnershipManifest();
  const alone = resolveGoOwnedEntryIds(manifest, [CATALOG_ENTRY_ID]);
  assert.equal(alone.entryIds.size, 0);
  assert.match(alone.errors[0], /moves only after every inference route/);

  const partial = resolveGoOwnedEntryIds(manifest, [CATALOG_ENTRY_ID, 'gateway.anthropic.messages']);
  assert.equal(partial.errors.length, 1);

  const complete = resolveGoOwnedEntryIds(manifest, [CATALOG_ENTRY_ID, ...INFERENCE_ENTRY_IDS]);
  assert.deepEqual(complete.errors, []);
  assert.equal(complete.entryIds.has(CATALOG_ENTRY_ID), true);

  // 目录无关的只读条目可以独立划转。
  assert.deepEqual(resolveGoOwnedEntryIds(manifest, ['gateway.props', 'gateway.models.detail']).errors, []);
});
