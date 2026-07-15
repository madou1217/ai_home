const test = require('node:test');
const assert = require('node:assert/strict');

const {
  indexProtocolEdges,
  normalizeProtocolId,
  resolveProtocolPath
} = require('../lib/server/protocol-graph');

test('protocol graph resolves identity, direct and multi-hop adapter paths', () => {
  const edges = [
    { id: 'agy_claude->anthropic_messages', sourceProtocol: 'agy_claude', targetProtocol: 'anthropic_messages' },
    { id: 'anthropic_messages->openai_chat', sourceProtocol: 'anthropic_messages', targetProtocol: 'openai_chat' },
    { id: 'openai_chat->openai_responses', sourceProtocol: 'openai_chat', targetProtocol: 'openai_responses' }
  ];

  assert.equal(normalizeProtocolId(' openai_chat '), 'openai_chat');
  assert.deepEqual(resolveProtocolPath(edges, 'openai_chat', 'openai_chat'), []);
  assert.deepEqual(
    resolveProtocolPath(edges, 'agy_claude', 'openai_responses').map((edge) => edge.id),
    [
      'agy_claude->anthropic_messages',
      'anthropic_messages->openai_chat',
      'openai_chat->openai_responses'
    ]
  );
});

test('protocol graph keeps provider ids out of protocol paths unless declared as edges', () => {
  const edges = [{
    id: 'anthropic_messages->openai_chat',
    sourceProtocol: 'anthropic_messages',
    targetProtocol: 'openai_chat'
  }];

  assert.equal(resolveProtocolPath(edges, 'anthropic_messages', 'agy'), null);
});

test('protocol graph can index custom edge key names for non-request pipelines', () => {
  const edges = [
    { id: 'raw->events', from: 'openai_chat', to: 'aih_canonical_events' },
    { id: 'events->target', from: 'aih_canonical_events', to: 'anthropic_messages' }
  ];
  const index = indexProtocolEdges(edges, { sourceKey: 'from', targetKey: 'to' });

  assert.equal(index.get('openai_chat')[0].id, 'raw->events');
  assert.deepEqual(
    resolveProtocolPath(edges, 'openai_chat', 'anthropic_messages', { sourceKey: 'from', targetKey: 'to' })
      .map((edge) => edge.id),
    ['raw->events', 'events->target']
  );
});
