'use strict';
const { extractRequestSessionKey } = require('./session-key');

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
    body: '',
    setHeader(key, value) {
      this.headers[String(key || '').toLowerCase()] = value;
    },
    end(chunk = '') {
      if (Buffer.isBuffer(chunk)) {
        this.body = chunk.toString('utf8');
      } else {
        this.body = String(chunk || '');
      }
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
    pathname,
    options,
    state,
    requiredClientKey,
    cooldownMs,
    maxRequestBodyBytes,
    requestMeta,
    deps
  } = ctx;

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

  if (!pathname.startsWith('/v1/')) return false;

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

  const requestStartedAt = Date.now();
  const routeKey = `${method} ${pathname}`;
  const sessionKey = extractRequestSessionKey(req.headers || {}, requestJson || {});
  const requestMetaWithSession = {
    ...(requestMeta || {}),
    sessionKey
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
    const merged = new Set();
    codexResult.ids.forEach((id) => merged.add(id));
    geminiResult.ids.forEach((id) => merged.add(id));
    claudeResult.ids.forEach((id) => merged.add(id));
    const mergedIds = Array.from(merged).sort();
    if (mergedIds.length > 0) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('x-aih-models-source', 'codex+gemini+claude');
      res.end(JSON.stringify(buildOpenAIModelsList(mergedIds)));
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

  if (method === 'POST' && pathname === '/v1/chat/completions' && options.backend === 'codex-adapter') {
    const provider = typeof resolveRequestProvider === 'function'
      ? resolveRequestProvider(options, requestJson || {})
      : 'codex';
    if (provider !== 'codex') {
      await handleUpstreamPassthrough({
        options,
        state,
        req,
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
    await handleCodexChatCompletions({
      options,
      state,
      req,
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
    req,
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
      appendProxyRequestLog
    }
  });
  return true;
}

module.exports = {
  handleV1Request
};
