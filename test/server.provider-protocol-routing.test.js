const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createProviderProtocolRouteDeps,
  createProviderProtocolRouteMeta,
  resolveProviderProtocolRoutePlan,
  resolveProviderProtocolTransport,
  resolveDirectProviderProtocolRoute,
  resolveProviderProtocolRouteForRequest,
  resolveProviderProtocolRouteForClientRequest,
  __private
} = require('../lib/server/provider-protocol-routing');
const {
  resolveProtocolRequestAdapterPath
} = require('../lib/server/protocol-request-adapter-registry');
const { dispatchProviderProtocolRoute } = require('../lib/server/provider-protocol-dispatcher');

test('provider protocol routing sends AGY Claude messages through direct Code Assist Anthropic adapter', () => {
  assert.deepEqual(resolveDirectProviderProtocolRoute('anthropic_messages', 'agy'), {
    id: 'anthropic_messages:agy:code_assist_direct',
    clientProtocol: 'anthropic_messages',
    provider: 'agy',
    transport: 'code_assist_anthropic_direct',
    upstreamProtocol: 'gemini_code_assist_generate_content',
    requestAdapter: 'claude2agyAdapter',
    responseAdapter: 'agy2claudeAdapter',
    modelFamilies: ['anthropic']
  });
});

test('provider protocol routing leaves AGY Gemini messages to fallback generateContent bridge', () => {
  assert.equal(resolveProviderProtocolRouteForRequest('anthropic_messages', 'agy', {
    model: 'gemini-3.5-flash-high'
  }), null);
});

test('provider protocol routing keeps official Claude messages on Anthropic passthrough', () => {
  assert.deepEqual(resolveDirectProviderProtocolRoute('anthropic_messages', 'claude'), {
    id: 'anthropic_messages:claude:passthrough',
    clientProtocol: 'anthropic_messages',
    provider: 'claude',
    transport: 'provider_passthrough',
    upstreamProtocol: 'anthropic_messages',
    requestAdapter: null,
    responseAdapter: null
  });
});

test('provider protocol routing does not force OpenAI client requests into AGY Claude direct path', () => {
  assert.equal(resolveDirectProviderProtocolRoute('openai_chat', 'agy'), null);
});

test('provider protocol routing sends OpenCode OpenAI chat through official Go API', () => {
  const route = resolveProviderProtocolRouteForClientRequest('openai_chat', 'opencode', {
    model: 'opencode-go/glm-5.2'
  });
  assert.deepEqual(route, {
    id: 'openai_chat:opencode:go_api',
    clientProtocol: 'openai_chat',
    provider: 'opencode',
    transport: 'opencode_go_api',
    upstreamProtocol: 'opencode_go_chat',
    requestAdapter: null,
    responseAdapter: null
  });
  assert.deepEqual(__private.resolveClientToRouteAdapterPath('openai_chat', route), []);
});

test('provider protocol routing applies model family constraints declaratively', () => {
  assert.equal(__private.modelMatchesFamily('claude-4-6-thinking', 'anthropic'), true);
  assert.equal(__private.modelMatchesFamily('Claude Sonnet 4.6 (Thinking)', 'anthropic'), true);
  assert.equal(__private.modelMatchesFamily('agy-claude-sonnet-4.6-thinking', 'anthropic'), true);
  assert.equal(__private.modelMatchesFamily('antigravity claude opus 4.6', 'anthropic'), true);
  assert.equal(__private.modelMatchesFamily('gemini-3.1-pro-high', 'anthropic'), false);
  assert.equal(__private.modelMatchesFamily('agy-gemini-3.1-pro-high', 'anthropic'), false);
  assert.equal(
    resolveProviderProtocolRouteForRequest('anthropic_messages', 'agy', { model: 'claude-4-6-thinking' }).transport,
    'code_assist_anthropic_direct'
  );
  assert.equal(
    resolveProviderProtocolRouteForRequest('anthropic_messages', 'agy', { model: 'agy-claude-sonnet-4.6-thinking' }).transport,
    'code_assist_anthropic_direct'
  );
  const agyGeminiRoute = resolveProviderProtocolRouteForRequest('anthropic_messages', 'agy', {
    model: 'gemini-3.1-pro-high'
  });
  assert.equal(
    agyGeminiRoute,
    null
  );
  assert.equal(
    resolveProviderProtocolRouteForRequest('anthropic_messages', 'claude', { model: 'qwen3.6-plus' }).transport,
    'provider_passthrough'
  );
});

test('provider protocol routing resolves reachable direct routes from any client protocol', () => {
  const openAIChatRoute = resolveProviderProtocolRouteForClientRequest('openai_chat', 'agy', {
    model: 'claude-4-6-thinking'
  });
  assert.equal(openAIChatRoute.clientProtocol, 'anthropic_messages');
  assert.equal(openAIChatRoute.transport, 'code_assist_anthropic_direct');
  assert.deepEqual(
    __private.resolveClientToRouteAdapterPath('openai_chat', openAIChatRoute).map((adapter) => adapter.id),
    ['openaiChat2claudeAdapter']
  );

  const responsesRoute = resolveProviderProtocolRouteForClientRequest('openai_responses', 'agy', {
    model: 'claude-4-6-thinking'
  });
  assert.equal(responsesRoute.transport, 'code_assist_anthropic_direct');
  assert.deepEqual(
    __private.resolveClientToRouteAdapterPath('openai_responses', responsesRoute).map((adapter) => adapter.id),
    ['codex2claudeAdapter']
  );

  assert.equal(resolveProviderProtocolRouteForClientRequest('openai_chat', 'agy', { model: 'gemini-3.1-pro-high' }), null);

  const geminiRoute = resolveProviderProtocolRouteForClientRequest('gemini_generate_content', 'agy', {
    model: 'claude-4-6-thinking'
  });
  assert.equal(geminiRoute.clientProtocol, 'anthropic_messages');
  assert.equal(geminiRoute.transport, 'code_assist_anthropic_direct');
  assert.deepEqual(
    __private.resolveClientToRouteAdapterPath('gemini_generate_content', geminiRoute).map((adapter) => adapter.id),
    ['gemini2claudeAdapter']
  );

  const geminiStreamRoute = resolveProviderProtocolRouteForClientRequest('gemini_stream_generate_content', 'agy', {
    model: 'claude-4-6-thinking'
  });
  assert.equal(geminiStreamRoute.clientProtocol, 'anthropic_messages');
  assert.equal(geminiStreamRoute.transport, 'code_assist_anthropic_direct');
  assert.deepEqual(
    __private.resolveClientToRouteAdapterPath('gemini_stream_generate_content', geminiStreamRoute).map((adapter) => adapter.id),
    ['geminiStream2claudeAdapter']
  );
  assert.equal(resolveProviderProtocolRouteForClientRequest('gemini_stream_generate_content', 'agy', {
    model: 'gemini-3.1-pro-high'
  }), null);
});

test('provider protocol routing uses provider-agnostic request adapter registry', () => {
  const route = resolveDirectProviderProtocolRoute('anthropic_messages', 'agy');
  assert.equal(resolveProtocolRequestAdapterPath('anthropic_messages', 'agy'), null);
  assert.deepEqual(
    __private.resolveClientToRouteAdapterPath('gemini_generate_content', route).map((adapter) => adapter.id),
    resolveProtocolRequestAdapterPath('gemini_generate_content', 'anthropic_messages').map((adapter) => adapter.id)
  );
});

test('provider protocol route registry is indexed by protocol and provider without route-specific branches', () => {
  const index = __private.indexProviderProtocolRoutes([{
    id: 'source:target:test',
    clientProtocol: 'source_protocol',
    provider: 'target_provider',
    transport: 'test_transport',
    upstreamProtocol: 'target_protocol',
    requestAdapter: 'source2targetAdapter',
    responseAdapter: 'target2sourceAdapter'
  }]);

  assert.deepEqual(index.source_protocol.target_provider, [{
    id: 'source:target:test',
    clientProtocol: 'source_protocol',
    provider: 'target_provider',
    transport: 'test_transport',
    upstreamProtocol: 'target_protocol',
    requestAdapter: 'source2targetAdapter',
    responseAdapter: 'target2sourceAdapter'
  }]);
});

test('provider protocol route registry keeps multiple candidates for one provider protocol key', () => {
  const firstRoute = {
    id: 'source:target:first',
    clientProtocol: 'source_protocol',
    provider: 'target_provider',
    transport: 'first_transport',
    upstreamProtocol: 'first_protocol',
    modelFamilies: ['first']
  };
  const secondRoute = {
    id: 'source:target:second',
    clientProtocol: 'source_protocol',
    provider: 'target_provider',
    transport: 'second_transport',
    upstreamProtocol: 'second_protocol',
    modelFamilies: ['second']
  };
  const index = __private.indexProviderProtocolRoutes([firstRoute, secondRoute]);

  assert.deepEqual(
    index.source_protocol.target_provider.map((route) => route.id),
    ['source:target:first', 'source:target:second']
  );
  assert.equal(Object.isFrozen(index.source_protocol.target_provider), true);
});

test('provider protocol route resolver selects a later same-key candidate when the first route does not match', () => {
  const firstRoute = {
    id: 'source:target:first',
    clientProtocol: 'source_protocol',
    provider: 'target_provider',
    transport: 'first_transport',
    upstreamProtocol: 'first_protocol',
    modelFamilies: ['gemini']
  };
  const secondRoute = {
    id: 'source:target:second',
    clientProtocol: 'source_protocol',
    provider: 'target_provider',
    transport: 'second_transport',
    upstreamProtocol: 'second_protocol',
    modelFamilies: ['anthropic']
  };
  const index = __private.indexProviderProtocolRoutes([firstRoute, secondRoute]);

  assert.equal(
    __private.resolveProviderProtocolRouteForRequestFromIndex(
      index,
      'source_protocol',
      'target_provider',
      { model: 'claude-4-6-thinking' }
    ).id,
    'source:target:second'
  );
});

test('provider protocol route dependency builder adds transport adapters and optional accounting', () => {
  const baseDeps = {
    chooseServerAccount: () => {},
    resolveRequestProvider: () => {},
    pushMetricError: () => {},
    writeJson: () => {},
    fetchWithTimeout: () => {},
    fetchGeminiCodeAssistChatCompletion: () => {},
    fetchGeminiCodeAssistChatCompletionStream: () => {},
    fetchCodeAssistAnthropicMessage: () => {},
    fetchCodeAssistAnthropicMessageStream: () => {},
    markProxyAccountFailure: () => {},
    markProxyAccountSuccess: () => {},
    appendProxyRequestLog: () => {},
    recordModelUsage: () => {},
    refreshCodexAccessToken: () => {},
    refreshClaudeAccessToken: () => {},
    unrelatedDependency: () => {}
  };

  const agyRoute = resolveDirectProviderProtocolRoute('anthropic_messages', 'agy');
  const agyDeps = createProviderProtocolRouteDeps(agyRoute, baseDeps);
  assert.equal(typeof agyDeps.fetchCodeAssistAnthropicMessage, 'function');
  assert.equal(typeof agyDeps.fetchCodeAssistAnthropicMessageStream, 'function');
  assert.equal(agyDeps.fetchGeminiCodeAssistChatCompletion, undefined);
  assert.equal(agyDeps.fetchGeminiCodeAssistChatCompletionStream, undefined);
  assert.equal(typeof agyDeps.recordModelUsage, 'function');
  assert.equal(agyDeps.refreshCodexAccessToken, undefined);
  assert.equal(agyDeps.refreshClaudeAccessToken, undefined);
  assert.equal(agyDeps.unrelatedDependency, undefined);

  const claudeRoute = resolveDirectProviderProtocolRoute('anthropic_messages', 'claude');
  const claudeDeps = createProviderProtocolRouteDeps(claudeRoute, baseDeps);
  assert.equal(claudeDeps.fetchCodeAssistAnthropicMessage, undefined);
  assert.equal(claudeDeps.fetchCodeAssistAnthropicMessageStream, undefined);
  assert.equal(claudeDeps.fetchGeminiCodeAssistChatCompletion, undefined);
  assert.equal(typeof claudeDeps.fetchWithTimeout, 'function');
  assert.equal(typeof claudeDeps.refreshClaudeAccessToken, 'function');
  assert.equal(claudeDeps.refreshCodexAccessToken, undefined);

  const opencodeRoute = resolveDirectProviderProtocolRoute('openai_chat', 'opencode');
  const opencodeDeps = createProviderProtocolRouteDeps(opencodeRoute, {
    ...baseDeps,
    fetchOpenCodeChatCompletion: () => {},
    fetchOpenCodeChatCompletionStream: () => {}
  });
  assert.equal(typeof opencodeDeps.fetchOpenCodeChatCompletion, 'function');
  assert.equal(opencodeDeps.fetchCodeAssistAnthropicMessage, undefined);

  const agyGeminiRoute = resolveProviderProtocolRouteForRequest('anthropic_messages', 'agy', {
    model: 'gemini-3.5-flash-high'
  });
  assert.equal(agyGeminiRoute, null);
});

test('provider protocol route dependency builder rejects incomplete direct transports', () => {
  const agyRoute = resolveDirectProviderProtocolRoute('anthropic_messages', 'agy');
  const deps = createProviderProtocolRouteDeps(agyRoute, {
    chooseServerAccount: () => {},
    resolveRequestProvider: () => {},
    pushMetricError: () => {},
    writeJson: () => {},
    fetchWithTimeout: () => {},
    fetchGeminiCodeAssistChatCompletion: () => {},
    fetchGeminiCodeAssistChatCompletionStream: () => {},
    fetchCodeAssistAnthropicMessage: () => {},
    markProxyAccountFailure: () => {},
    markProxyAccountSuccess: () => {},
    appendProxyRequestLog: () => {},
    refreshCodexAccessToken: () => {}
  });

  assert.equal(deps, null);
});

test('provider protocol route dependency builder rejects incomplete common dependencies', () => {
  const route = resolveDirectProviderProtocolRoute('anthropic_messages', 'agy');
  const deps = createProviderProtocolRouteDeps(route, {
    chooseServerAccount: () => {},
    resolveRequestProvider: () => {},
    pushMetricError: () => {},
    writeJson: () => {},
    fetchWithTimeout: () => {},
    fetchCodeAssistAnthropicMessage: () => {},
    fetchCodeAssistAnthropicMessageStream: () => {},
    markProxyAccountSuccess: () => {},
    appendProxyRequestLog: () => {}
  });

  assert.equal(deps, null);
});

test('provider protocol route plan requires transport adapter metadata to match', () => {
  const route = resolveDirectProviderProtocolRoute('anthropic_messages', 'agy');
  const validPlan = resolveProviderProtocolRoutePlan({
    providerProtocolRoute: createProviderProtocolRouteMeta(route)
  });
  assert.deepEqual(validPlan, createProviderProtocolRouteMeta(route));

  const invalidPlan = resolveProviderProtocolRoutePlan({
    providerProtocolRoute: {
      ...route,
      requestAdapter: 'claude2openaiChatAdapter'
    }
  });
  assert.equal(invalidPlan, null);
  assert.equal(resolveProviderProtocolTransport({
    providerProtocolRoute: {
      ...route,
      responseAdapter: ''
    }
  }), '');
});

test('provider protocol dispatcher carries route metadata into upstream transport', async () => {
  const route = resolveDirectProviderProtocolRoute('anthropic_messages', 'agy');
  let seenRequestMeta = null;
  const dispatched = await dispatchProviderProtocolRoute({
    route,
    options: {},
    state: {},
    req: { url: '/v1/messages' },
    res: {},
    method: 'POST',
    bodyBuffer: Buffer.from('{}'),
    routeKey: 'POST /v1/messages',
    requestStartedAt: 1,
    cooldownMs: 1000,
    requestJson: { model: 'claude-4-6-thinking' },
    requestMeta: { sessionKey: 'thread-1', effectiveProvider: 'agy' },
    handleUpstreamPassthrough: async (ctx) => {
      seenRequestMeta = ctx.requestMeta;
    },
    deps: {
      chooseServerAccount: () => {},
      resolveRequestProvider: () => {},
      pushMetricError: () => {},
      writeJson: () => {},
      fetchWithTimeout: () => {},
      fetchGeminiCodeAssistChatCompletion: () => {},
      fetchGeminiCodeAssistChatCompletionStream: () => {},
      fetchCodeAssistAnthropicMessage: () => {},
      fetchCodeAssistAnthropicMessageStream: () => {},
      markProxyAccountFailure: () => {},
      markProxyAccountSuccess: () => {},
      appendProxyRequestLog: () => {},
      refreshCodexAccessToken: () => {}
    }
  });

  assert.equal(dispatched, true);
  assert.equal(seenRequestMeta.sessionKey, 'thread-1');
  assert.equal(seenRequestMeta.effectiveProvider, 'agy');
  assert.equal(seenRequestMeta.clientProtocol, 'anthropic_messages');
  assert.equal(seenRequestMeta.sourceClientProtocol, 'anthropic_messages');
  assert.deepEqual(seenRequestMeta.protocolAdapterPath, []);
  assert.deepEqual(seenRequestMeta.providerProtocolRoute, createProviderProtocolRouteMeta(route));
  assert.equal(seenRequestMeta.providerProtocolPlan.sourceClientProtocol, 'anthropic_messages');
  assert.equal(seenRequestMeta.providerProtocolPlan.clientProtocol, 'anthropic_messages');
  assert.equal(seenRequestMeta.providerProtocolPlan.nativeDirect, true);
  assert.deepEqual(seenRequestMeta.providerProtocolPlan.requestAdapterPath, []);
  assert.equal(
    resolveProviderProtocolTransport(seenRequestMeta),
    'code_assist_anthropic_direct'
  );
});
