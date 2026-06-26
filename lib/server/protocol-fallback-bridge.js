'use strict';

const {
  applyProtocolRequestAdapterPath,
  applyProtocolResponseAdapterPath,
  resolveProtocolRequestAdapterPath
} = require('./protocol-adapters');
const {
  buildProtocolRequestPath,
  listFallbackRequestProtocols
} = require('./protocol-registry');
const { createSseTransformStream } = require('./protocol-stream-pipeline');
const { resolveProviderProtocolRouteForClientRequest } = require('./provider-protocol-routing');
const { dispatchProviderProtocolRoute } = require('./provider-protocol-dispatcher');
const {
  compactProviderProtocolPlan,
  createProviderProtocolPlan
} = require('./provider-protocol-plan');

function createMemoryResponse() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    body: '',
    writableEnded: false,
    setHeader(key, value) {
      this.headers[String(key || '').toLowerCase()] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = Number(statusCode) || this.statusCode || 200;
      Object.entries(headers || {}).forEach(([key, value]) => this.setHeader(key, value));
    },
    flushHeaders() {},
    write(chunk = '') {
      if (this.writableEnded) return false;
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      this.chunks.push(text);
      this.body = this.chunks.join('');
      return true;
    },
    end(chunk = '') {
      if (chunk !== undefined && chunk !== null && String(chunk).length > 0) this.write(chunk);
      this.writableEnded = true;
    }
  };
}

function withEffectiveProvider(requestMeta, provider) {
  return {
    ...(requestMeta || {}),
    effectiveProvider: provider
  };
}

function extractErrorMessage(bodyText, fallback = '') {
  const text = String(bodyText || '').trim();
  if (text) {
    try {
      const parsed = JSON.parse(text);
      const message = String(
        parsed && parsed.error && parsed.error.message
        || parsed && parsed.detail
        || parsed && parsed.message
        || ''
      ).trim();
      if (message) return message;
    } catch (_error) {}
  }
  return text || String(fallback || '').trim() || 'upstream request failed';
}

function formatProtocolErrorBody(targetProtocol, statusCode, bodyText) {
  const protocol = String(targetProtocol || '').trim();
  if (protocol !== 'openai_responses') return bodyText;
  try {
    const parsed = JSON.parse(String(bodyText || ''));
    if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object') {
      return JSON.stringify(parsed);
    }
  } catch (_error) {}
  return JSON.stringify({
    error: {
      message: extractErrorMessage(bodyText, `upstream_${statusCode}`),
      type: statusCode === 404 ? 'not_found_error' : 'invalid_request_error',
      param: null,
      code: null
    }
  });
}

function createStreamingProtocolResponse(res, options = {}) {
  const headers = {};
  let statusCode = 200;
  let rawBody = '';
  let bufferedOutput = '';
  let transform = null;
  let streamingStarted = false;
  let writableEnded = false;

  const writeTarget = (chunk) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (!text) return;
    if (typeof res.write === 'function') {
      res.write(text);
      return;
    }
    bufferedOutput += text;
  };

  const copyHeadersToTarget = (skipContentHeaders) => {
    Object.entries(headers).forEach(([key, value]) => {
      const low = String(key || '').toLowerCase();
      if (skipContentHeaders && (low === 'content-type' || low === 'content-length' || low === 'transfer-encoding')) return;
      if (low === 'content-length' || low === 'transfer-encoding') return;
      res.setHeader(key, value);
    });
  };

  const startStreaming = () => {
    if (streamingStarted) return;
    streamingStarted = true;
    res.statusCode = statusCode;
    copyHeadersToTarget(true);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    transform = createSseTransformStream(options.sourceProtocol, options.targetProtocol, {
      fallbackModel: options.fallbackModel,
      onChunk: writeTarget
    });
  };

  const endTarget = (chunk) => {
    if (typeof res.end === 'function') {
      res.end(typeof res.write === 'function' ? chunk : bufferedOutput + String(chunk || ''));
    }
  };

  return {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value) {
      statusCode = Number(value) || statusCode || 200;
    },
    headers,
    get body() {
      return rawBody || bufferedOutput;
    },
    get writableEnded() {
      return writableEnded;
    },
    // 暴露 headersSent，让上层（重试编排）能判断"是否已向客户端开始流式"——一旦开始就不能换账号重试。
    get headersSent() {
      return streamingStarted;
    },
    setHeader(key, value) {
      const normalizedKey = String(key || '').toLowerCase();
      headers[normalizedKey] = value;
      // 真实 res 头已发出后再转发 x-aih-* 会抛 ERR_HTTP_HEADERS_SENT（重试时的元凶），加 headersSent 守卫。
      if (streamingStarted && normalizedKey.startsWith('x-aih-') && !res.headersSent) {
        res.setHeader(normalizedKey, value);
      }
    },
    writeHead(nextStatusCode, nextHeaders = {}) {
      statusCode = Number(nextStatusCode) || statusCode || 200;
      Object.entries(nextHeaders || {}).forEach(([key, value]) => this.setHeader(key, value));
    },
    flushHeaders() {
      if (statusCode < 400) startStreaming();
    },
    write(chunk = '') {
      if (writableEnded) return false;
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      if (statusCode >= 400) {
        rawBody += text;
        return true;
      }
      startStreaming();
      transform.write(text);
      return true;
    },
    end(chunk = '') {
      if (writableEnded) return;
      if (chunk !== undefined && chunk !== null && String(chunk).length > 0) this.write(chunk);
      writableEnded = true;
      if (statusCode >= 400) {
        res.statusCode = statusCode;
        copyHeadersToTarget(false);
        const formattedBody = formatProtocolErrorBody(options.targetProtocol, statusCode, rawBody);
        if (formattedBody !== rawBody) {
          res.setHeader('content-type', 'application/json; charset=utf-8');
        }
        res.end(formattedBody);
        return;
      }
      if (!transform) startStreaming();
      transform.end();
      endTarget('');
    }
  };
}

function writeLocalJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function copyBufferedHeaders(res, bufferedRes, skipContentHeaders = false) {
  Object.entries(bufferedRes && bufferedRes.headers || {}).forEach(([key, value]) => {
    const low = String(key || '').toLowerCase();
    if (skipContentHeaders && (low === 'content-type' || low === 'content-length')) return;
    if (low === 'content-length') return;
    res.setHeader(key, value);
  });
}

function writeBufferedResponse(res, bufferedRes) {
  res.statusCode = Number(bufferedRes && bufferedRes.statusCode || 200);
  copyBufferedHeaders(res, bufferedRes);
  res.end(String(bufferedRes && bufferedRes.body || ''));
}

function isAliasRuntimeFailureResult(result) {
  return Boolean(result && result.retryAliasCandidate);
}

function writeProtocolAdapterUnavailable(res, statusCode, direction, sourceProtocol, targetProtocol) {
  writeLocalJson(res, statusCode, {
    ok: false,
    error: `protocol_adapter_${direction}_unavailable`,
    sourceProtocol: String(sourceProtocol || ''),
    targetProtocol: String(targetProtocol || '')
  });
}

function writeProtocolGatewayUnavailable(res, fallbackProtocol) {
  writeLocalJson(res, 500, {
    ok: false,
    error: 'protocol_gateway_unavailable',
    fallbackProtocol: String(fallbackProtocol || '')
  });
}

const PROVIDER_FALLBACK_REQUEST_PROTOCOLS = Object.freeze({
  codex: Object.freeze(['openai_responses', 'openai_chat']),
  gemini: Object.freeze(['gemini_generate_content', 'gemini_stream_generate_content', 'openai_chat']),
  agy: Object.freeze(['gemini_generate_content', 'gemini_stream_generate_content', 'openai_chat'])
});

function canAdaptProtocolRequest(sourceProtocol, targetProtocol) {
  return Array.isArray(resolveProtocolRequestAdapterPath(sourceProtocol, targetProtocol));
}

function prioritizeFallbackRequestProtocols(candidates, options = {}) {
  const list = Array.isArray(candidates) ? candidates.slice() : [];
  if (!options || !options.stream) return list;
  return list.sort((left, right) => {
    const leftStream = String(left || '').includes('stream_generate_content') ? 0 : 1;
    const rightStream = String(right || '').includes('stream_generate_content') ? 0 : 1;
    return leftStream - rightStream;
  });
}

function resolveProviderFallbackRequestProtocol(clientProtocol, provider, options = {}) {
  const route = resolveProviderProtocolRouteForClientRequest(
    clientProtocol,
    provider,
    options && options.requestJson || {}
  );
  const routeProtocol = String(route && route.clientProtocol || '').trim();
  if (
    routeProtocol
    && routeProtocol !== String(clientProtocol || '').trim()
    && canAdaptProtocolRequest(clientProtocol, routeProtocol)
  ) {
    return routeProtocol;
  }
  const candidates = prioritizeFallbackRequestProtocols(
    PROVIDER_FALLBACK_REQUEST_PROTOCOLS[String(provider || '').trim().toLowerCase()] || [],
    options
  );
  return candidates.find((protocol) => canAdaptProtocolRequest(clientProtocol, protocol)) || '';
}

function resolveFallbackRequestProtocol(clientProtocol, provider, options = {}) {
  const providerFallback = resolveProviderFallbackRequestProtocol(clientProtocol, provider, options);
  if (providerFallback) return providerFallback;
  return listFallbackRequestProtocols(clientProtocol)
    .find((protocol) => canAdaptProtocolRequest(clientProtocol, protocol)) || '';
}

function adaptProtocolRequest(input = {}) {
  const adapted = applyProtocolRequestAdapterPath({
    sourceProtocol: input.sourceProtocol,
    targetProtocol: input.targetProtocol,
    payload: input.payload,
    context: input.context || {}
  });
  return adapted || null;
}

function adaptProtocolRequestPayload(input = {}) {
  const adapted = adaptProtocolRequest(input);
  return adapted ? adapted.payload : null;
}

function writeProtocolResponseFromBuffered(res, bufferedRes, input = {}) {
  const statusCode = Number(bufferedRes && bufferedRes.statusCode || 200);
  if (statusCode >= 400) {
    writeBufferedResponse(res, bufferedRes);
    return;
  }
  const body = String(bufferedRes && bufferedRes.body || '');
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch (_error) {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    writeLocalJson(res, 502, {
      ok: false,
      error: 'invalid_protocol_adapter_response'
    });
    return;
  }
  const adapted = applyProtocolResponseAdapterPath({
    sourceProtocol: input.sourceProtocol,
    targetProtocol: input.targetProtocol,
    payload: parsed,
    context: input.context || {}
  });
  if (!adapted) {
    writeProtocolAdapterUnavailable(res, 502, 'response', input.sourceProtocol, input.targetProtocol);
    return;
  }
  res.statusCode = 200;
  copyBufferedHeaders(res, bufferedRes, true);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(adapted.payload));
}

function createFallbackProtocolRequest(res, input = {}) {
  const fallbackProtocol = resolveFallbackRequestProtocol(input.clientProtocol, input.provider, {
    stream: Boolean(input.context && input.context.stream || input.payload && input.payload.stream),
    requestJson: input.payload || {}
  });
  const requestJson = adaptProtocolRequestPayload({
    sourceProtocol: input.clientProtocol,
    targetProtocol: fallbackProtocol,
    payload: input.payload,
    context: input.context || {}
  });
  if (!requestJson) {
    writeProtocolAdapterUnavailable(res, 500, 'request', input.clientProtocol, fallbackProtocol);
    return null;
  }
  return { fallbackProtocol, requestJson };
}

function resolveProviderProtocolRouteForBridge(clientProtocol, provider, requestJson = {}) {
  return resolveProviderProtocolRouteForClientRequest(clientProtocol, provider, requestJson);
}

async function runOpenAIChatViaProviderProtocolRoute(ctx, route) {
  return await runClientProtocolViaProviderProtocolRoute({
    ...ctx,
    clientProtocol: 'openai_chat',
    route,
    context: { pathname: '/v1/chat/completions' }
  });
}

async function runClientProtocolViaProviderProtocolRoute(ctx) {
  const {
    clientProtocol,
    provider,
    options,
    state,
    req,
    res,
    method,
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestJson,
    requestMeta,
    deps,
    route,
    context
  } = ctx;
  const providerPlan = createProviderProtocolPlan({
    route,
    provider,
    sourceClientProtocol: clientProtocol,
    clientProtocol
  });
  const routeClientProtocol = providerPlan && providerPlan.clientProtocol
    || route && route.clientProtocol
    || 'anthropic_messages';
  const routeContext = context && typeof context === 'object' ? context : {};
  const routeRequest = adaptProtocolRequest({
    sourceProtocol: clientProtocol,
    targetProtocol: routeClientProtocol,
    payload: requestJson || {},
    context: routeContext
  });
  const routeRequestJson = routeRequest && routeRequest.payload;
  if (!routeRequestJson) {
    writeProtocolAdapterUnavailable(res, 500, 'request', clientProtocol, routeClientProtocol);
    return;
  }

  const routeRequestPath = buildProtocolRequestPath(routeClientProtocol, { requestJson: routeRequestJson });
  if (!routeRequestPath) {
    writeProtocolGatewayUnavailable(res, routeClientProtocol);
    return;
  }
  const routeReq = {
    ...req,
    url: routeRequestPath
  };
  const wantsStream = Boolean(
    requestJson && requestJson.stream
    || routeRequestJson && routeRequestJson.stream
    || routeContext.stream
  );
  const routeRes = wantsStream
    ? createStreamingProtocolResponse(res, {
      sourceProtocol: routeClientProtocol,
      targetProtocol: clientProtocol,
      fallbackModel: routeRequestJson && routeRequestJson.model || requestJson && requestJson.model
    })
    : createMemoryResponse();
  const dispatched = await dispatchProviderProtocolRoute({
    route,
    options,
    state,
    req: routeReq,
    res: routeRes,
    method,
    bodyBuffer: Buffer.from(JSON.stringify(routeRequestJson)),
    routeKey: `${method || 'POST'} ${routeRequestPath}`,
    requestStartedAt,
    cooldownMs,
    requestJson: routeRequestJson,
    requestMeta: withEffectiveProvider({
      ...(requestMeta || {}),
      sourceClientProtocol: clientProtocol,
      protocolAdapterPath: routeRequest.adapters || [],
      ...(providerPlan ? { providerProtocolPlan: compactProviderProtocolPlan(providerPlan) } : {})
    }, provider),
    handleUpstreamPassthrough: deps && deps.handleUpstreamPassthrough,
    deps
  });
  if (!dispatched) {
    writeLocalJson(res, 500, {
      ok: false,
      error: 'provider_protocol_route_unavailable',
      detail: `direct provider protocol route is not wired: ${route && route.id || ''}`,
      clientProtocol,
      provider
    });
    return;
  }
  if (isAliasRuntimeFailureResult(dispatched)) return dispatched;
  if (!wantsStream) {
    writeProtocolResponseFromBuffered(res, routeRes, {
      sourceProtocol: clientProtocol,
      targetProtocol: routeClientProtocol,
      context: {
        ...routeContext,
        fallbackModel: routeRequestJson && routeRequestJson.model || requestJson && requestJson.model
      }
    });
  }
  return dispatched;
}

async function runOpenAIResponsesGateway(ctx) {
  const {
    provider,
    options,
    state,
    req,
    res,
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestJson,
    requestMeta,
    deps
  } = ctx;
  const {
    chooseServerAccount,
    pushMetricError,
    writeJson,
    fetchWithTimeout,
    markProxyAccountFailure,
    markProxyAccountSuccess,
    appendProxyRequestLog,
    refreshCodexAccessToken,
    recordModelUsage,
    handleCodexChatCompletions
  } = deps;
  const providerRoute = resolveProviderProtocolRouteForBridge('openai_responses', provider, requestJson);
  if (providerRoute) {
    return await runClientProtocolViaProviderProtocolRoute({
      ...ctx,
      clientProtocol: 'openai_responses',
      route: providerRoute,
      context: { pathname: '/v1/responses' }
    });
  }
  if (provider === 'codex' && typeof handleCodexChatCompletions === 'function') {
    await handleCodexChatCompletions({
      options,
      state,
      req: {
        ...req,
        url: '/v1/responses'
      },
      res,
      requestJson,
      routeKey,
      requestStartedAt,
      cooldownMs,
      requestMeta: {
        ...withEffectiveProvider(requestMeta, provider),
        clientProtocol: 'openai_responses'
      },
      deps: {
        chooseServerAccount,
        pushMetricError,
        writeJson,
        fetchWithTimeout,
        markProxyAccountFailure,
        markProxyAccountSuccess,
        appendProxyRequestLog,
        refreshCodexAccessToken,
        recordModelUsage
      }
    });
    return;
  }
  writeLocalJson(res, 500, {
    ok: false,
    error: 'provider_protocol_gateway_unavailable',
    fallbackProtocol: 'openai_responses',
    provider: String(provider || '')
  });
}

async function runOpenAIChatGateway(ctx) {
  const {
    provider,
    options,
    state,
    req,
    res,
    method,
    bodyBuffer,
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestJson,
    requestMeta,
    deps
  } = ctx;
  const {
    chooseServerAccount,
    resolveRequestProvider,
    pushMetricError,
    writeJson,
    fetchWithTimeout,
    fetchModelsForAccount,
    fetchGeminiCodeAssistChatCompletion,
    fetchGeminiCodeAssistChatCompletionStream,
    fetchOpenCodeChatCompletion,
    fetchOpenCodeChatCompletionStream,
    markProxyAccountFailure,
    markProxyAccountSuccess,
    appendProxyRequestLog,
    refreshCodexAccessToken,
    recordModelUsage,
    handleCodexChatCompletions,
    handleUpstreamPassthrough
  } = deps;
  const openAIReq = {
    ...req,
    url: '/v1/chat/completions'
  };
  const providerRoute = resolveProviderProtocolRouteForBridge('openai_chat', provider, requestJson);
  if (providerRoute) {
    return await runOpenAIChatViaProviderProtocolRoute(ctx, providerRoute);
  }
  if (provider === 'codex') {
    await handleCodexChatCompletions({
      options,
      state,
      req: openAIReq,
      res,
      requestJson,
      routeKey,
      requestStartedAt,
      cooldownMs,
      requestMeta: withEffectiveProvider(requestMeta, provider),
      deps: {
        chooseServerAccount,
        pushMetricError,
        writeJson,
        fetchWithTimeout,
        markProxyAccountFailure,
        markProxyAccountSuccess,
        appendProxyRequestLog,
        refreshCodexAccessToken,
        recordModelUsage
      }
    });
    return;
  }
  return await handleUpstreamPassthrough({
    options,
    state,
    req: openAIReq,
    res,
    method,
    bodyBuffer,
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestJson,
    requestMeta: withEffectiveProvider(requestMeta, provider),
    deps: {
      chooseServerAccount,
      resolveRequestProvider,
      pushMetricError,
      writeJson,
      fetchWithTimeout,
      fetchModelsForAccount,
      fetchGeminiCodeAssistChatCompletion,
      fetchGeminiCodeAssistChatCompletionStream,
      fetchOpenCodeChatCompletion,
      fetchOpenCodeChatCompletionStream,
      markProxyAccountFailure,
      markProxyAccountSuccess,
      appendProxyRequestLog,
      refreshCodexAccessToken,
      recordModelUsage
    }
  });
}

async function runGeminiGenerateContentGateway(ctx) {
  const {
    provider,
    options,
    state,
    req,
    res,
    method,
    bodyBuffer,
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestJson,
    requestMeta,
    fallbackProtocol,
    deps
  } = ctx;
  const {
    chooseServerAccount,
    resolveRequestProvider,
    pushMetricError,
    writeJson,
    fetchWithTimeout,
    fetchModelsForAccount,
    fetchGeminiCodeAssistChatCompletion,
    fetchGeminiCodeAssistChatCompletionStream,
    fetchGeminiCodeAssistGenerateContent,
    fetchGeminiCodeAssistGenerateContentStream,
    fetchOpenCodeChatCompletion,
    fetchOpenCodeChatCompletionStream,
    markProxyAccountFailure,
    markProxyAccountSuccess,
    appendProxyRequestLog,
    refreshCodexAccessToken,
    recordModelUsage,
    handleUpstreamPassthrough
  } = deps;
  const stream = String(fallbackProtocol || '').trim() === 'gemini_stream_generate_content';
  const gatewayProtocol = stream ? 'gemini_stream_generate_content' : 'gemini_generate_content';
  const requestPath = buildProtocolRequestPath(gatewayProtocol, { requestJson });
  const providerRoute = resolveProviderProtocolRouteForBridge(gatewayProtocol, provider, requestJson);
  if (providerRoute) {
    return await runClientProtocolViaProviderProtocolRoute({
      ...ctx,
      clientProtocol: gatewayProtocol,
      route: providerRoute,
      context: { pathname: requestPath, stream }
    });
  }
  return await handleUpstreamPassthrough({
    options,
    state,
    req: {
      ...req,
      url: requestPath
    },
    res,
    method,
    bodyBuffer,
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestJson,
    requestMeta: {
      ...withEffectiveProvider(requestMeta, provider),
      clientProtocol: gatewayProtocol
    },
    deps: {
      chooseServerAccount,
      resolveRequestProvider,
      pushMetricError,
      writeJson,
      fetchWithTimeout,
      fetchModelsForAccount,
      fetchGeminiCodeAssistChatCompletion,
      fetchGeminiCodeAssistChatCompletionStream,
      fetchGeminiCodeAssistGenerateContent,
      fetchGeminiCodeAssistGenerateContentStream,
      fetchOpenCodeChatCompletion,
      fetchOpenCodeChatCompletionStream,
      markProxyAccountFailure,
      markProxyAccountSuccess,
      appendProxyRequestLog,
      refreshCodexAccessToken,
      recordModelUsage
    }
  });
}

const FALLBACK_PROTOCOL_GATEWAY_RUNNERS = Object.freeze({
  gemini_generate_content: Object.freeze({
    id: 'gemini_generate_content_gateway',
    protocol: 'gemini_generate_content',
    run: runGeminiGenerateContentGateway
  }),
  openai_responses: Object.freeze({
    id: 'openai_responses_gateway',
    protocol: 'openai_responses',
    run: runOpenAIResponsesGateway
  }),
  openai_chat: Object.freeze({
    id: 'openai_chat_gateway',
    protocol: 'openai_chat',
    run: runOpenAIChatGateway
  }),
  gemini_stream_generate_content: Object.freeze({
    id: 'gemini_stream_generate_content_gateway',
    protocol: 'gemini_stream_generate_content',
    run: runGeminiGenerateContentGateway
  })
});

function resolveFallbackProtocolGateway(protocol, gateways = FALLBACK_PROTOCOL_GATEWAY_RUNNERS) {
  const key = String(protocol || '').trim();
  if (!key || !gateways || typeof gateways !== 'object') return null;
  return gateways[key] || null;
}

async function runFallbackProtocolBridge(input = {}) {
  const {
    clientProtocol,
    provider,
    options,
    state,
    req,
    res,
    method,
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestMeta,
    bridgeRequest,
    deps
  } = input;
  const wantsStream = Boolean(
    bridgeRequest && bridgeRequest.requestJson && bridgeRequest.requestJson.stream
    || bridgeRequest && bridgeRequest.fallbackProtocol === 'gemini_stream_generate_content'
  );
  const gateway = resolveFallbackProtocolGateway(bridgeRequest && bridgeRequest.fallbackProtocol);
  if (!gateway || typeof gateway.run !== 'function') {
    writeProtocolGatewayUnavailable(res, bridgeRequest && bridgeRequest.fallbackProtocol);
    return;
  }
  const upstreamRes = wantsStream
    ? createStreamingProtocolResponse(res, {
      sourceProtocol: bridgeRequest.fallbackProtocol,
      targetProtocol: clientProtocol,
      fallbackModel: bridgeRequest.requestJson && bridgeRequest.requestJson.model
    })
    : createMemoryResponse();
  const result = await gateway.run({
    provider,
    options,
    state,
    req,
    res: upstreamRes,
    method,
    bodyBuffer: Buffer.from(JSON.stringify(bridgeRequest.requestJson)),
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestJson: bridgeRequest.requestJson,
    requestMeta,
    fallbackProtocol: bridgeRequest.fallbackProtocol,
    deps
  });
  if (isAliasRuntimeFailureResult(result)) return result;
  if (!wantsStream) {
    writeProtocolResponseFromBuffered(res, upstreamRes, {
      sourceProtocol: clientProtocol,
      targetProtocol: bridgeRequest.fallbackProtocol,
      context: { fallbackModel: bridgeRequest.requestJson && bridgeRequest.requestJson.model }
    });
  }
  return result;
}

module.exports = {
  createFallbackProtocolRequest,
  createMemoryResponse,
  resolveProviderProtocolRouteForBridge,
  runFallbackProtocolBridge,
  runClientProtocolViaProviderProtocolRoute,
  runOpenAIChatGateway,
  withEffectiveProvider,
  __private: {
    adaptProtocolRequest,
    adaptProtocolRequestPayload,
    copyBufferedHeaders,
    createStreamingProtocolResponse,
    extractErrorMessage,
    formatProtocolErrorBody,
    FALLBACK_PROTOCOL_GATEWAY_RUNNERS,
    canAdaptProtocolRequest,
    PROVIDER_FALLBACK_REQUEST_PROTOCOLS,
    prioritizeFallbackRequestProtocols,
    resolveFallbackProtocolGateway,
    resolveFallbackRequestProtocol,
    resolveProviderFallbackRequestProtocol,
    resolveProviderProtocolRouteForBridge,
    runGeminiGenerateContentGateway,
    runOpenAIResponsesGateway,
    runOpenAIChatViaProviderProtocolRoute,
    writeBufferedResponse,
    writeProtocolAdapterUnavailable,
    writeProtocolGatewayUnavailable,
    writeProtocolResponseFromBuffered
  }
};
