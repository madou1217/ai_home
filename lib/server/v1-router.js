'use strict';
const { extractRequestSessionKey } = require('./session-key');
const {
  detectClientProtocol,
  convertAnthropicMessagesToOpenAIChat,
  convertOpenAIChatToAnthropicMessages,
  convertGeminiGenerateContentToOpenAIChat,
  convertOpenAIResponsesToOpenAIChat,
  convertOpenAIChatCompletionToAnthropicMessage,
  convertOpenAIChatSseToAnthropicSse,
  convertAnthropicMessageToOpenAIChatCompletion,
  convertAnthropicSseToOpenAIChatSse,
  convertOpenAIChatCompletionToGeminiGenerateContent,
  convertOpenAIChatSseToGeminiSse,
  convertOpenAIChatCompletionToOpenAIResponse,
  convertOpenAIChatSseToOpenAIResponseSse
} = require('./protocol-adapters');
const { normalizePathname } = require('./protocol-registry');
const { createSseTransformStream } = require('./protocol-stream-pipeline');
const {
  resolveAlias,
  resolveAliasUpstreamProvider
} = require('./model-alias-store');
const { isSupportedProvider } = require('./providers');
const { resolveGatewayProvider } = require('./capability-router');
const {
  buildGatewayModelEntries,
  mergeGatewayModelEntries
} = require('./gateway-model-list');

function rewriteRequestUrlPathname(req, pathname) {
  if (!req || typeof req !== 'object') return req;
  const originalUrl = String(req.url || '');
  const safePathname = String(pathname || '').trim() || '/';
  const queryIndex = originalUrl.indexOf('?');
  const query = queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';
  return {
    ...req,
    url: `${safePathname}${query}`
  };
}

function sanitizeUndefinedSentinel(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeUndefinedSentinel(item))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.trim() === '[undefined]') return undefined;
    return value;
  }
  const out = {};
  Object.entries(value).forEach(([key, item]) => {
    const sanitized = sanitizeUndefinedSentinel(item);
    if (sanitized === undefined) return;
    out[key] = sanitized;
  });
  return out;
}

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
    setHeader(key, value) {
      const normalizedKey = String(key || '').toLowerCase();
      headers[normalizedKey] = value;
      if (streamingStarted && normalizedKey.startsWith('x-aih-')) {
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

function parseOpenAIModelIdsFromBody(bodyText) {
  const text = String(bodyText || '').trim();
  if (!text) return [];
  try {
    const payload = JSON.parse(text);
    const list = Array.isArray(payload && payload.data) ? payload.data : [];
    return list
      .map((item) => String(item && item.id || '').trim())
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function writeLocalJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function writeGatewayProviderUnavailable(res, result, clientProtocol) {
  writeLocalJson(res, 503, {
    ok: false,
    error: 'no_available_account',
    detail: String(result && result.detail || 'no account in the global pool can serve this request'),
    clientProtocol: String(clientProtocol || ''),
    model: String(result && result.model || ''),
    familyProvider: String(result && result.familyProvider || ''),
    availability: result && result.availability ? result.availability : undefined
  });
}

function requireGatewayProvider(res, input) {
  const result = resolveGatewayProvider(input);
  if (result && result.provider) return result.provider;
  writeGatewayProviderUnavailable(res, result, input && input.clientProtocol);
  return '';
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

function writeAnthropicMessageFromOpenAIChat(res, bufferedRes, requestJson) {
  const statusCode = Number(bufferedRes && bufferedRes.statusCode || 200);
  if (statusCode >= 400) {
    writeBufferedResponse(res, bufferedRes);
    return;
  }
  const body = String(bufferedRes && bufferedRes.body || '');
  const wantsStream = Boolean(requestJson && requestJson.stream);
  res.statusCode = 200;
  copyBufferedHeaders(res, bufferedRes, true);
  if (wantsStream) {
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.end(convertOpenAIChatSseToAnthropicSse(body, requestJson && requestJson.model));
    return;
  }
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
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(convertOpenAIChatCompletionToAnthropicMessage(parsed, requestJson && requestJson.model)));
}

function writeOpenAIChatFromAnthropicMessage(res, bufferedRes, requestJson) {
  const statusCode = Number(bufferedRes && bufferedRes.statusCode || 200);
  if (statusCode >= 400) {
    writeBufferedResponse(res, bufferedRes);
    return;
  }
  const body = String(bufferedRes && bufferedRes.body || '');
  const wantsStream = Boolean(requestJson && requestJson.stream);
  res.statusCode = 200;
  copyBufferedHeaders(res, bufferedRes, true);
  if (wantsStream) {
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.end(convertAnthropicSseToOpenAIChatSse(body, requestJson && requestJson.model));
    return;
  }
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
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(convertAnthropicMessageToOpenAIChatCompletion(parsed, requestJson && requestJson.model)));
}

function writeGeminiGenerateContentFromOpenAIChat(res, bufferedRes, requestJson) {
  const statusCode = Number(bufferedRes && bufferedRes.statusCode || 200);
  if (statusCode >= 400) {
    writeBufferedResponse(res, bufferedRes);
    return;
  }
  const body = String(bufferedRes && bufferedRes.body || '');
  const wantsStream = Boolean(requestJson && requestJson.stream);
  res.statusCode = 200;
  copyBufferedHeaders(res, bufferedRes, true);
  if (wantsStream) {
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.end(convertOpenAIChatSseToGeminiSse(body, requestJson && requestJson.model));
    return;
  }
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
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(convertOpenAIChatCompletionToGeminiGenerateContent(parsed, requestJson && requestJson.model)));
}

function writeOpenAIResponseFromOpenAIChat(res, bufferedRes, requestJson) {
  const statusCode = Number(bufferedRes && bufferedRes.statusCode || 200);
  if (statusCode >= 400) {
    writeBufferedResponse(res, bufferedRes);
    return;
  }
  const body = String(bufferedRes && bufferedRes.body || '');
  const wantsStream = Boolean(requestJson && requestJson.stream);
  res.statusCode = 200;
  copyBufferedHeaders(res, bufferedRes, true);
  if (wantsStream) {
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.end(convertOpenAIChatSseToOpenAIResponseSse(body, requestJson && requestJson.model));
    return;
  }
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
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(convertOpenAIChatCompletionToOpenAIResponse(parsed, requestJson && requestJson.model)));
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
    fetchGeminiCodeAssistChatCompletion,
    fetchGeminiCodeAssistChatCompletionStream,
    markProxyAccountFailure,
    markProxyAccountSuccess,
    appendProxyRequestLog,
    refreshCodexAccessToken,
    handleCodexChatCompletions,
    handleUpstreamPassthrough
  } = deps;
  const openAIReq = {
    ...req,
    url: '/v1/chat/completions'
  };
  if (provider === 'claude') {
    const anthropicRequestJson = convertOpenAIChatToAnthropicMessages(requestJson || {});
    const anthropicReq = {
      ...req,
      url: '/v1/messages'
    };
    const wantsStream = Boolean(requestJson && requestJson.stream);
    const claudeRes = wantsStream
      ? createStreamingProtocolResponse(res, {
        sourceProtocol: 'anthropic_messages',
        targetProtocol: 'openai_chat',
        fallbackModel: requestJson && requestJson.model
      })
      : createMemoryResponse();
    await handleUpstreamPassthrough({
      options,
      state,
      req: anthropicReq,
      res: claudeRes,
      method,
      bodyBuffer: Buffer.from(JSON.stringify(anthropicRequestJson)),
      routeKey: 'POST /v1/messages',
      requestStartedAt,
      cooldownMs,
      requestJson: anthropicRequestJson,
      requestMeta: withEffectiveProvider(requestMeta, provider),
      deps: {
        chooseServerAccount,
        resolveRequestProvider,
        pushMetricError,
        writeJson,
        fetchWithTimeout,
        fetchGeminiCodeAssistChatCompletion,
        fetchGeminiCodeAssistChatCompletionStream,
        markProxyAccountFailure,
        markProxyAccountSuccess,
        appendProxyRequestLog,
        refreshCodexAccessToken
      }
    });
    if (!wantsStream) writeOpenAIChatFromAnthropicMessage(res, claudeRes, requestJson || {});
    return;
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
        refreshCodexAccessToken
      }
    });
    return;
  }
  await handleUpstreamPassthrough({
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
      fetchGeminiCodeAssistChatCompletion,
      fetchGeminiCodeAssistChatCompletionStream,
      markProxyAccountFailure,
      markProxyAccountSuccess,
      appendProxyRequestLog,
      refreshCodexAccessToken
    }
  });
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch (_error) {
    return String(value || '');
  }
}

function getModelIdFromModelsPath(pathname) {
  const match = String(pathname || '').match(/^\/v1\/models\/([^/]+)$/);
  if (!match) return '';
  return decodePathSegment(match[1]).trim();
}

async function collectModelIdsFromHandler(handler, baseCtx) {
  if (typeof handler !== 'function') return { ids: [], statusCode: 500, body: '' };
  const memoryRes = createMemoryResponse();
  await handler({
    ...baseCtx,
    res: memoryRes
  });
  return {
    ids: parseOpenAIModelIdsFromBody(memoryRes.body),
    statusCode: Number(memoryRes.statusCode || 0),
    body: memoryRes.body
  };
}

async function handleV1Request(ctx) {
  const {
    req,
    res,
    method,
    pathname: rawPathname,
    options,
    state,
    requiredClientKey,
    cooldownMs,
    maxRequestBodyBytes,
    requestMeta,
    deps
  } = ctx;
  const pathname = normalizePathname(rawPathname);
  const routingReq = pathname === rawPathname ? req : rewriteRequestUrlPathname(req, pathname);

  const {
    parseAuthorizationBearer,
    writeJson,
    readRequestBody,
    buildOpenAIModelsList,
    resolveRequestProvider,
    chooseServerAccount,
    markProxyAccountSuccess,
    markProxyAccountFailure,
    pushMetricError,
    appendProxyRequestLog,
    handleUpstreamModels,
    handleUpstreamPassthrough,
    handleCodexModels,
    handleCodexChatCompletions,
    fetchModelsForAccount,
    fetchGeminiCodeAssistChatCompletion,
    fetchGeminiCodeAssistChatCompletionStream,
    FALLBACK_MODELS,
    fetchWithTimeout,
    refreshCodexAccessToken
  } = deps;

  if (!pathname.startsWith('/v1/') && !pathname.startsWith('/v1beta/')) return false;

  if (requiredClientKey) {
    const incoming = parseAuthorizationBearer(req.headers.authorization);
    if (incoming !== requiredClientKey) {
      writeJson(res, 401, { ok: false, error: 'unauthorized_client' });
      return true;
    }
  }

  const bodyBufferResult = await readRequestBody(req, { maxBytes: maxRequestBodyBytes }).catch((error) => ({ __error: error }));
  if (!bodyBufferResult || bodyBufferResult.__error) {
    const err = bodyBufferResult && bodyBufferResult.__error;
    if (err && err.code === 'request_body_too_large') {
      writeJson(res, 413, { ok: false, error: 'request_body_too_large' });
      return true;
    }
    writeJson(res, 400, { ok: false, error: 'invalid_request_body' });
    return true;
  }
  const bodyBuffer = bodyBufferResult;

  let requestJson = null;
  try {
    requestJson = bodyBuffer.length > 0 ? JSON.parse(bodyBuffer.toString('utf8')) : {};
  } catch (e) {
    requestJson = {};
  }
  let upstreamBodyBuffer = bodyBuffer;
  if (requestJson && typeof requestJson === 'object' && bodyBuffer.length > 0) {
    try {
      const sanitizedRequest = sanitizeUndefinedSentinel(requestJson);
      if (sanitizedRequest && typeof sanitizedRequest === 'object') {
        upstreamBodyBuffer = Buffer.from(JSON.stringify(sanitizedRequest));
        requestJson = sanitizedRequest;
      }
    } catch (_error) {
      upstreamBodyBuffer = bodyBuffer;
    }
  }

  // Model alias resolution
  let aliasTargetProvider = '';
  let preferModelRouting = false;
  if (requestJson && typeof requestJson.model === 'string') {
    const clientProtocol = detectClientProtocol(method, pathname);
    let baseProvider = typeof deps.resolveRequestProvider === 'function'
      ? deps.resolveRequestProvider(options, requestJson, routingReq && routingReq.headers, state)
      : 'codex';

    // For protocol-specific paths, we know the intended provider before resolution
    if (clientProtocol === 'anthropic_messages') baseProvider = 'claude';
    else if (clientProtocol === 'gemini_generate_content' || clientProtocol === 'gemini_stream_generate_content') baseProvider = 'gemini';

    const aliasResult = resolveAlias(state.modelAliases && state.modelAliases.aliases, requestJson.model, baseProvider);
    if (aliasResult) {
      requestJson.model = aliasResult.target;
      upstreamBodyBuffer = Buffer.from(JSON.stringify(requestJson));
      aliasTargetProvider = isSupportedProvider(aliasResult.targetProvider) ? resolveAliasUpstreamProvider(aliasResult) : '';
      preferModelRouting = !aliasTargetProvider;
    }
  }

  const requestStartedAt = Date.now();
  const routeKey = `${method} ${pathname}`;
  const sessionKey = extractRequestSessionKey(routingReq.headers || {}, requestJson || {});
  const requestMetaWithSession = {
    ...(requestMeta || {}),
    sessionKey,
    ...(aliasTargetProvider ? { effectiveProvider: aliasTargetProvider } : {})
  };
  state.metrics.totalRequests += 1;
  state.metrics.routeCounts[routeKey] = Number(state.metrics.routeCounts[routeKey] || 0) + 1;

  if (method === 'GET' && pathname === '/v1/models' && options.backend === 'codex-adapter') {
    const providerMode = String((options && options.provider) || 'auto').trim().toLowerCase();
    if (providerMode === 'codex') {
      await handleCodexModels({
        options,
        state,
        res,
        deps: {
          buildOpenAIModelsList,
          fetchWithTimeout
        }
      });
      return true;
    }
    if (providerMode === 'gemini' || providerMode === 'claude') {
      await handleUpstreamModels({
        options: { ...options, provider: providerMode },
        state,
        res,
        deps: {
          buildOpenAIModelsList,
          fetchModelsForAccount,
          FALLBACK_MODELS
        }
      });
      return true;
    }
    const codexResult = await collectModelIdsFromHandler(handleCodexModels, {
      options,
      state,
      deps: {
        buildOpenAIModelsList,
        fetchWithTimeout
      }
    });
    const geminiResult = await collectModelIdsFromHandler(handleUpstreamModels, {
      options: { ...options, provider: 'gemini' },
      state: {
        ...state,
        modelsCache: { updatedAt: 0, ids: [], byAccount: {}, sourceCount: 0 }
      },
      deps: {
        buildOpenAIModelsList,
        fetchModelsForAccount,
        FALLBACK_MODELS
      }
    });
    const claudeResult = await collectModelIdsFromHandler(handleUpstreamModels, {
      options: { ...options, provider: 'claude' },
      state: {
        ...state,
        modelsCache: { updatedAt: 0, ids: [], byAccount: {}, sourceCount: 0 }
      },
      deps: {
        buildOpenAIModelsList,
        fetchModelsForAccount,
        FALLBACK_MODELS
      }
    });
    const aliases = state.modelAliases && Array.isArray(state.modelAliases.aliases)
      ? state.modelAliases.aliases
      : [];
    const mergedList = mergeGatewayModelEntries([
      ...buildGatewayModelEntries(state, options),
      ...codexResult.ids.map((id) => ({ id, provider: 'codex', source: 'remote' })),
      ...geminiResult.ids.map((id) => ({ id, provider: 'gemini', source: 'remote' })),
      ...claudeResult.ids.map((id) => ({ id, provider: 'claude', source: 'remote' }))
    ], aliases);
    if (mergedList.length > 0) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('x-aih-models-source', 'global-capability-pool');
      res.end(JSON.stringify(buildOpenAIModelsList(mergedList)));
      return true;
    }
    if (codexResult.statusCode >= 400 && codexResult.body) {
      res.statusCode = codexResult.statusCode;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(codexResult.body);
      return true;
    }
    await handleCodexModels({
      options,
      state,
      res,
      deps: {
        buildOpenAIModelsList,
        fetchWithTimeout
      }
    });
    return true;
  }

  const modelIdFromPath = method === 'GET' ? getModelIdFromModelsPath(pathname) : '';
  if (modelIdFromPath) {
    writeLocalJson(res, 200, {
      id: modelIdFromPath,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'aih-server'
    });
    return true;
  }

  if (method === 'GET' && pathname === '/v1/props') {
    writeLocalJson(res, 200, {
      object: 'props',
      data: {}
    });
    return true;
  }

  const clientProtocol = detectClientProtocol(method, pathname);
  if (clientProtocol === 'anthropic_messages' && options.backend === 'codex-adapter') {
    const openAIRequestJson = convertAnthropicMessagesToOpenAIChat(requestJson || {});
    const provider = requireGatewayProvider(res, {
      options,
      state,
      requestJson: openAIRequestJson,
      headers: routingReq && routingReq.headers,
      clientProtocol,
      aliasTargetProvider,
      preferModelRouting
    });
    if (!provider) return true;
    if (provider === 'claude') {
      await handleUpstreamPassthrough({
        options,
        state,
        req: routingReq,
        res,
        method,
        bodyBuffer: upstreamBodyBuffer,
        routeKey,
        requestStartedAt,
        cooldownMs,
        requestJson,
        requestMeta: withEffectiveProvider(requestMetaWithSession, provider),
        deps: {
          chooseServerAccount,
          resolveRequestProvider,
          pushMetricError,
          writeJson,
          fetchWithTimeout,
          fetchGeminiCodeAssistChatCompletion,
          fetchGeminiCodeAssistChatCompletionStream,
          markProxyAccountFailure,
          markProxyAccountSuccess,
          appendProxyRequestLog,
          refreshCodexAccessToken
        }
      });
      return true;
    }

    const wantsStream = Boolean(openAIRequestJson && openAIRequestJson.stream);
    const upstreamRes = wantsStream
      ? createStreamingProtocolResponse(res, {
        sourceProtocol: 'openai_chat',
        targetProtocol: 'anthropic_messages',
        fallbackModel: openAIRequestJson && openAIRequestJson.model
      })
      : createMemoryResponse();
    const openAIBodyBuffer = Buffer.from(JSON.stringify(openAIRequestJson));
    await runOpenAIChatGateway({
      provider,
      options,
      state,
      req: routingReq,
      res: upstreamRes,
      method,
      bodyBuffer: openAIBodyBuffer,
      routeKey,
      requestStartedAt,
      cooldownMs,
      requestJson: openAIRequestJson,
      requestMeta: requestMetaWithSession,
      deps: {
        chooseServerAccount,
        resolveRequestProvider,
        pushMetricError,
        writeJson,
        fetchWithTimeout,
        fetchGeminiCodeAssistChatCompletion,
        fetchGeminiCodeAssistChatCompletionStream,
        markProxyAccountFailure,
        markProxyAccountSuccess,
        appendProxyRequestLog,
        refreshCodexAccessToken,
        handleCodexChatCompletions,
        handleUpstreamPassthrough
      }
    });
    if (!wantsStream) writeAnthropicMessageFromOpenAIChat(res, upstreamRes, requestJson || {});
    return true;
  }

  if ((clientProtocol === 'gemini_generate_content' || clientProtocol === 'gemini_stream_generate_content') && options.backend === 'codex-adapter') {
    const openAIRequestJson = convertGeminiGenerateContentToOpenAIChat(
      requestJson || {},
      pathname,
      clientProtocol === 'gemini_stream_generate_content'
    );
    const provider = requireGatewayProvider(res, {
      options,
      state,
      requestJson: openAIRequestJson,
      headers: routingReq && routingReq.headers,
      clientProtocol,
      aliasTargetProvider,
      preferModelRouting
    });
    if (!provider) return true;
    const wantsStream = Boolean(openAIRequestJson && openAIRequestJson.stream);
    const upstreamRes = wantsStream
      ? createStreamingProtocolResponse(res, {
        sourceProtocol: 'openai_chat',
        targetProtocol: clientProtocol,
        fallbackModel: openAIRequestJson && openAIRequestJson.model
      })
      : createMemoryResponse();
    await runOpenAIChatGateway({
      provider,
      options,
      state,
      req: routingReq,
      res: upstreamRes,
      method,
      bodyBuffer: Buffer.from(JSON.stringify(openAIRequestJson)),
      routeKey,
      requestStartedAt,
      cooldownMs,
      requestJson: openAIRequestJson,
      requestMeta: requestMetaWithSession,
      deps: {
        chooseServerAccount,
        resolveRequestProvider,
        pushMetricError,
        writeJson,
        fetchWithTimeout,
        fetchGeminiCodeAssistChatCompletion,
        fetchGeminiCodeAssistChatCompletionStream,
        markProxyAccountFailure,
        markProxyAccountSuccess,
        appendProxyRequestLog,
        refreshCodexAccessToken,
        handleCodexChatCompletions,
        handleUpstreamPassthrough
      }
    });
    if (!wantsStream) writeGeminiGenerateContentFromOpenAIChat(res, upstreamRes, openAIRequestJson);
    return true;
  }

  if (clientProtocol === 'openai_responses' && options.backend === 'codex-adapter') {
    const responseRequestJson = requestJson || {};
    const provider = requireGatewayProvider(res, {
      options,
      state,
      requestJson: responseRequestJson,
      headers: routingReq && routingReq.headers,
      clientProtocol,
      aliasTargetProvider,
      preferModelRouting
    });
    if (!provider) return true;
    if (provider === 'codex') {
      await handleCodexChatCompletions({
        options,
        state,
        req: routingReq,
        res,
        requestJson: responseRequestJson,
        routeKey,
        requestStartedAt,
        cooldownMs,
        requestMeta: {
          ...requestMetaWithSession,
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
          refreshCodexAccessToken
        }
      });
      return true;
    }
    const openAIRequestJson = convertOpenAIResponsesToOpenAIChat(responseRequestJson);
    const wantsStream = Boolean(openAIRequestJson && openAIRequestJson.stream);
    const upstreamRes = wantsStream
      ? createStreamingProtocolResponse(res, {
        sourceProtocol: 'openai_chat',
        targetProtocol: 'openai_responses',
        fallbackModel: openAIRequestJson && openAIRequestJson.model
      })
      : createMemoryResponse();
    await runOpenAIChatGateway({
      provider,
      options,
      state,
      req: routingReq,
      res: upstreamRes,
      method,
      bodyBuffer: Buffer.from(JSON.stringify(openAIRequestJson)),
      routeKey,
      requestStartedAt,
      cooldownMs,
      requestJson: openAIRequestJson,
      requestMeta: requestMetaWithSession,
      deps: {
        chooseServerAccount,
        resolveRequestProvider,
        pushMetricError,
        writeJson,
        fetchWithTimeout,
        fetchGeminiCodeAssistChatCompletion,
        fetchGeminiCodeAssistChatCompletionStream,
        markProxyAccountFailure,
        markProxyAccountSuccess,
        appendProxyRequestLog,
        refreshCodexAccessToken,
        handleCodexChatCompletions,
        handleUpstreamPassthrough
      }
    });
    if (!wantsStream) writeOpenAIResponseFromOpenAIChat(res, upstreamRes, openAIRequestJson);
    return true;
  }

  if (method === 'POST' && pathname === '/v1/chat/completions' && options.backend === 'codex-adapter') {
    const provider = requireGatewayProvider(res, {
      options,
      state,
      requestJson: requestJson || {},
      headers: routingReq && routingReq.headers,
      clientProtocol,
      aliasTargetProvider,
      preferModelRouting
    });
    if (!provider) return true;
    if (provider !== 'codex') {
      if (provider === 'claude') {
        await runOpenAIChatGateway({
          provider,
          options,
          state,
          req: routingReq,
          res,
          method,
          bodyBuffer: upstreamBodyBuffer,
          routeKey,
          requestStartedAt,
          cooldownMs,
          requestJson,
          requestMeta: requestMetaWithSession,
          deps: {
            chooseServerAccount,
            resolveRequestProvider,
            pushMetricError,
            writeJson,
            fetchWithTimeout,
            fetchGeminiCodeAssistChatCompletion,
            fetchGeminiCodeAssistChatCompletionStream,
            markProxyAccountFailure,
            markProxyAccountSuccess,
            appendProxyRequestLog,
            refreshCodexAccessToken,
            handleCodexChatCompletions,
            handleUpstreamPassthrough
          }
        });
        return true;
      }
      await handleUpstreamPassthrough({
        options,
        state,
        req: routingReq,
        res,
        method,
        bodyBuffer: upstreamBodyBuffer,
        routeKey,
        requestStartedAt,
        cooldownMs,
        requestJson,
        requestMeta: withEffectiveProvider(requestMetaWithSession, provider),
        deps: {
          chooseServerAccount,
          resolveRequestProvider,
          pushMetricError,
          writeJson,
          fetchWithTimeout,
          fetchGeminiCodeAssistChatCompletion,
          fetchGeminiCodeAssistChatCompletionStream,
          markProxyAccountFailure,
          markProxyAccountSuccess,
          appendProxyRequestLog,
          refreshCodexAccessToken
        }
      });
      return true;
    }
    await handleCodexChatCompletions({
      options,
      state,
      req: routingReq,
      res,
      requestJson,
      routeKey,
      requestStartedAt,
      cooldownMs,
      requestMeta: requestMetaWithSession,
      deps: {
        chooseServerAccount,
        pushMetricError,
        writeJson,
        fetchWithTimeout,
        markProxyAccountFailure,
        markProxyAccountSuccess,
        appendProxyRequestLog,
        refreshCodexAccessToken
      }
    });
    return true;
  }

  if (method === 'GET' && pathname === '/v1/models') {
    await handleUpstreamModels({
      options,
      state,
      res,
      deps: {
        buildOpenAIModelsList,
        fetchModelsForAccount,
        FALLBACK_MODELS
      }
    });
    return true;
  }

  await handleUpstreamPassthrough({
    options,
    state,
    req: routingReq,
    res,
    method,
    bodyBuffer: upstreamBodyBuffer,
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestJson,
    requestMeta: requestMetaWithSession,
    deps: {
      chooseServerAccount,
      resolveRequestProvider,
      pushMetricError,
      writeJson,
      fetchWithTimeout,
      fetchGeminiCodeAssistChatCompletion,
      fetchGeminiCodeAssistChatCompletionStream,
      markProxyAccountFailure,
      markProxyAccountSuccess,
      appendProxyRequestLog,
      refreshCodexAccessToken
    }
  });
  return true;
}

module.exports = {
  handleV1Request
};
