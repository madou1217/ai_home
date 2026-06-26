const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROVIDER_PROTOCOL_CANONICAL_EVENT_PROTOCOL,
  compactProviderProtocolPlan,
  createProviderProtocolPlan,
  mergeProviderProtocolPlanIntoRequestMeta,
  __private
} = require('../lib/server/provider-protocol-plan');
const {
  resolveDirectProviderProtocolRoute,
  resolveProviderProtocolRouteForClientRequest
} = require('../lib/server/provider-protocol-routing');

test('provider protocol plan keeps Claude to AGY native direct path unwrapped', () => {
  const route = resolveDirectProviderProtocolRoute('anthropic_messages', 'agy');
  const plan = createProviderProtocolPlan({
    route,
    provider: 'agy',
    clientProtocol: 'anthropic_messages'
  });

  assert.equal(plan.sourceClientProtocol, 'anthropic_messages');
  assert.equal(plan.clientProtocol, 'anthropic_messages');
  assert.equal(plan.provider, 'agy');
  assert.equal(plan.transport, 'code_assist_anthropic_direct');
  assert.equal(plan.upstreamProtocol, 'gemini_code_assist_generate_content');
  assert.equal(plan.requestAdapter, 'claude2agyAdapter');
  assert.equal(plan.responseAdapter, 'agy2claudeAdapter');
  assert.deepEqual(plan.requestAdapterPath, []);
  assert.deepEqual(plan.responseAdapterPath, []);
  assert.equal(plan.nativeDirect, true);
  assert.equal(plan.canonicalEventProtocol, PROVIDER_PROTOCOL_CANONICAL_EVENT_PROTOCOL);
});

test('provider protocol plan records composed OpenAI Responses to AGY Claude adapter path', () => {
  const route = resolveProviderProtocolRouteForClientRequest('openai_responses', 'agy', {
    model: 'claude-opus-4.6-thinking'
  });
  const plan = createProviderProtocolPlan({
    route,
    provider: 'agy',
    clientProtocol: 'openai_responses'
  });

  assert.equal(plan.sourceClientProtocol, 'openai_responses');
  assert.equal(plan.clientProtocol, 'anthropic_messages');
  assert.equal(plan.nativeDirect, false);
  assert.deepEqual(plan.requestAdapterPath, ['codex2claudeAdapter']);
  assert.deepEqual(plan.responseAdapterPath, ['codex2claudeAdapter']);
  assert.equal(plan.upstreamRequestAdapter, 'claude2agyAdapter');
  assert.equal(plan.downstreamResponseAdapter, 'agy2claudeAdapter');
});

test('provider protocol plan rejects unreachable client protocol instead of inventing fallbacks', () => {
  const route = resolveDirectProviderProtocolRoute('anthropic_messages', 'agy');
  assert.equal(createProviderProtocolPlan({
    route,
    provider: 'agy',
    clientProtocol: 'unknown_protocol'
  }), null);
});

test('provider protocol plan compacts metadata for diagnostics', () => {
  const route = resolveProviderProtocolRouteForClientRequest('gemini_generate_content', 'agy', {
    model: 'claude-sonnet-4.6-thinking'
  });
  const plan = createProviderProtocolPlan({
    route,
    provider: 'agy',
    clientProtocol: 'gemini_generate_content'
  });
  const compact = compactProviderProtocolPlan(plan);

  assert.deepEqual(Object.keys(compact).sort(), [
    'canonicalEventProtocol',
    'clientProtocol',
    'downstreamResponseAdapter',
    'id',
    'nativeDirect',
    'provider',
    'requestAdapter',
    'requestAdapterPath',
    'responseAdapter',
    'responseAdapterPath',
    'routeClientProtocol',
    'sourceClientProtocol',
    'transport',
    'upstreamProtocol',
    'upstreamRequestAdapter'
  ].sort());
  assert.equal(compact.sourceClientProtocol, 'gemini_generate_content');
  assert.equal(compact.clientProtocol, 'anthropic_messages');
  assert.deepEqual(compact.requestAdapterPath, ['gemini2claudeAdapter']);
});

test('provider protocol plan merge preserves an existing adapter path from the executed request adapter', () => {
  const route = resolveProviderProtocolRouteForClientRequest('openai_chat', 'agy', {
    model: 'claude-opus-4.6-thinking'
  });
  const meta = mergeProviderProtocolPlanIntoRequestMeta({
    sourceClientProtocol: 'openai_chat',
    clientProtocol: 'anthropic_messages',
    protocolAdapterPath: ['already-executed-adapter'],
    effectiveProvider: 'agy',
    providerProtocolRoute: route
  });

  assert.deepEqual(meta.protocolAdapterPath, ['already-executed-adapter']);
  assert.equal(meta.providerProtocolPlan.sourceClientProtocol, 'openai_chat');
  assert.deepEqual(meta.providerProtocolPlan.requestAdapterPath, ['openaiChat2claudeAdapter']);
});

test('provider protocol plan merge fills inferred adapter path when existing path is empty', () => {
  const route = resolveProviderProtocolRouteForClientRequest('gemini_generate_content', 'agy', {
    model: 'claude-opus-4.6-thinking'
  });
  const meta = mergeProviderProtocolPlanIntoRequestMeta({
    sourceClientProtocol: 'gemini_generate_content',
    clientProtocol: 'anthropic_messages',
    protocolAdapterPath: [],
    effectiveProvider: 'agy',
    providerProtocolRoute: route
  });

  assert.deepEqual(meta.protocolAdapterPath, ['gemini2claudeAdapter']);
  assert.deepEqual(meta.providerProtocolPlan.requestAdapterPath, ['gemini2claudeAdapter']);
});

test('provider protocol plan private adapter id helper ignores malformed entries', () => {
  assert.deepEqual(__private.listAdapterIds([
    { id: 'a->b' },
    null,
    { id: '' },
    { id: 'b->c' }
  ]), ['a->b', 'b->c']);
});
