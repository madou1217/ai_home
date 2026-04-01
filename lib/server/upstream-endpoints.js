'use strict';

const { resolveRequestProvider } = require('./router');
const { listEnabledProviders } = require('./providers');

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection'
]);

function shouldSkipForwardHeader(headerName) {
  const key = String(headerName || '').toLowerCase();
  return key === 'host'
    || key === 'authorization'
    || key === 'content-length'
    || HOP_BY_HOP_HEADERS.has(key);
}

function normalizeHeaderValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean).join(', ');
  }
  return String(value == null ? '' : value).trim();
}

function isSafeHeaderValue(value) {
  return !/[\u0000-\u0008\u000A-\u001F\u007F]/.test(String(value || ''));
}

function sanitizeAccessToken(rawToken) {
  const token = String(rawToken || '').trim();
  if (!token) return '';
  if (/[\r\n\0]/.test(token)) return '';
  return token;
}

function describeUpstreamError(error) {
  const message = String((error && error.message) || error || 'unknown_error');
  const code = String(
    (error && error.code)
    || (error && error.cause && error.cause.code)
    || ''
  ).trim();
  if (!code || message.includes(code)) return message;
  return `${message} [${code}]`;
}

function isGlobalNetworkFailure(error) {
  const code = String(
    (error && error.code)
    || (error && error.cause && error.cause.code)
    || ''
  ).trim().toUpperCase();
  if ([
    'ECONNRESET',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN'
  ].includes(code)) {
    return true;
  }
  const msg = String((error && error.message) || '').toLowerCase();
  return msg.includes('secure tls connection')
    || msg.includes('network socket disconnected')
    || msg.includes('fetch failed');
}

function withNetworkHint(detail, upstreamBase) {
  const upstream = String(upstreamBase || '').trim();
  const parts = [
    String(detail || '').trim(),
    'hint: check upstream reachability'
  ];
  if (upstream) {
    parts.push(`upstream=${upstream}`);
  }
  parts.push('proxy=AIH_SERVER_PROXY_URL/https_proxy/http_proxy');
  return parts.filter(Boolean).join(' | ');
}

function mapGeminiFinishReason(reason) {
  const value = String(reason || '').trim().toUpperCase();
  if (value === 'MAX_TOKENS') return 'length';
  if (value === 'UNEXPECTED_TOOL_CALL') return 'tool_calls';
  return 'stop';
}

function resolveProviderUpstream(options, provider, account) {
  if (provider === 'gemini') {
    return String(options && options.geminiBaseUrl || '').trim().replace(/\/+$/, '');
  }
  if (provider === 'claude') {
    const fromAccount = String(account && account.baseUrl || '').trim();
    return (fromAccount || String(options && options.claudeBaseUrl || '').trim()).replace(/\/+$/, '');
  }
  return String(options && options.codexBaseUrl || '').trim().replace(/\/+$/, '');
}

function resolveProviderPath(provider, reqUrl) {
  const rawPath = String(reqUrl || '').trim() || '/';
  if ((provider === 'gemini' || provider === 'claude') && rawPath.startsWith('/v1/')) {
    return rawPath.slice(3);
  }
  if ((provider === 'gemini' || provider === 'claude') && rawPath === '/v1') {
    return '/';
  }
  return rawPath;
}

async function handleUpstreamModels(ctx) {
  const {
    options,
    state,
    res,
    deps
  } = ctx;

  const {
    buildOpenAIModelsList,
    fetchModelsForAccount,
    FALLBACK_MODELS
  } = deps;

  const now = Date.now();
  const ttl = Math.max(1000, Number(options.modelsCacheTtlMs) || 300000);
  if (state.modelsCache.updatedAt > 0 && now - state.modelsCache.updatedAt < ttl && Array.isArray(state.modelsCache.ids)) {
    const payload = buildOpenAIModelsList(state.modelsCache.ids.length > 0 ? state.modelsCache.ids : FALLBACK_MODELS);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
    return;
  }

  const candidateLimit = Math.max(1, Number(options.modelsProbeAccounts) || 2);
  const fallbackModelSet = new Set();
  const candidatePool = [];
  listEnabledProviders(options && options.provider).forEach((provider) => {
    if (provider === 'codex') return;
    const accounts = Array.isArray(state.accounts && state.accounts[provider]) ? state.accounts[provider] : [];
    accounts.forEach((account) => {
      const availableModels = Array.isArray(account && account.availableModels) ? account.availableModels : [];
      availableModels.forEach((id) => {
        const safe = String(id || '').trim();
        if (safe) fallbackModelSet.add(safe);
      });
    });
    accounts
      .filter((a) => !!a.accessToken && Date.now() >= (a.cooldownUntil || 0))
      .forEach((account) => {
        candidatePool.push(account);
      });
  });
  const candidates = candidatePool.slice(0, candidateLimit);
  const modelSet = new Set();
  let firstError = '';
  const probeTimeout = Math.min(4000, options.upstreamTimeoutMs);
  const settled = await Promise.allSettled(
    candidates.map((acc) => fetchModelsForAccount(options, acc, probeTimeout))
  );
  settled.forEach((result) => {
    if (result.status === 'fulfilled') {
      result.value.forEach((m) => modelSet.add(m));
      return;
    }
    if (!firstError) firstError = String((result.reason && result.reason.message) || result.reason);
  });
  let ids = Array.from(modelSet).sort();
  if (ids.length === 0 && fallbackModelSet.size > 0) {
    ids = Array.from(fallbackModelSet).sort();
  }
  state.modelsCache = {
    updatedAt: now,
    ids,
    byAccount: {},
    sourceCount: ids.length > 0 ? candidates.length : 0
  };
  const payload = buildOpenAIModelsList(ids.length > 0 ? ids : FALLBACK_MODELS);
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (ids.length === 0 && firstError) {
    res.setHeader('x-aih-models-fallback', '1');
  }
  res.end(JSON.stringify(payload));
}

async function handleUpstreamPassthrough(ctx) {
  const {
    options,
    state,
    req,
    res,
    method,
    bodyBuffer,
    requestJson,
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestMeta,
    deps
  } = ctx;

  const {
    chooseServerAccount,
    pushMetricError,
    writeJson,
    fetchWithTimeout,
    fetchGeminiCodeAssistChatCompletion,
    fetchGeminiCodeAssistChatCompletionStream,
    markProxyAccountFailure,
    markProxyAccountSuccess,
    appendProxyRequestLog,
    refreshCodexAccessToken
  } = deps;

  const provider = typeof deps.resolveRequestProvider === 'function'
    ? deps.resolveRequestProvider(options, requestJson || {})
    : resolveRequestProvider(options, requestJson || {});
  if (!state.metrics.providerCounts || typeof state.metrics.providerCounts !== 'object') state.metrics.providerCounts = {};
  if (!state.metrics.providerSuccess || typeof state.metrics.providerSuccess !== 'object') state.metrics.providerSuccess = {};
  if (!state.metrics.providerFailures || typeof state.metrics.providerFailures !== 'object') state.metrics.providerFailures = {};
  state.metrics.providerCounts[provider] = Number(state.metrics.providerCounts[provider] || 0) + 1;
  const streamRequested = !!(requestJson && requestJson.stream);
  let streamTransport = streamRequested ? 'unknown' : 'non_stream';
  let lastError = '';
  let finalStatusCode = 502;
  const pool = Array.isArray(state.accounts && state.accounts[provider]) ? state.accounts[provider] : [];
  const baseMaxAttempts = Math.min(
    Math.max(1, Number(options.maxAttempts) || 3),
    Math.max(1, pool.length)
  );
  const authRetryBudget = (
    provider === 'codex'
    && typeof refreshCodexAccessToken === 'function'
    && pool.length > 0
  ) ? 1 : 0;
  const maxAttempts = baseMaxAttempts + authRetryBudget;
  const attemptedIds = new Set();
  const forcedRefreshRetryUsed = new Set();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const account = chooseServerAccount(pool, state.cursors, provider, {
      provider,
      sessionKey: (requestMeta && requestMeta.sessionKey) || '',
      excludeIds: attemptedIds
    });
    if (!account) {
      state.metrics.totalFailures += 1;
      pushMetricError(state.metrics, routeKey, provider, 'no_available_account');
      writeJson(res, 503, { ok: false, error: 'no_available_account' });
      return;
    }
    attemptedIds.add(String(account.id || ''));
    const upstreamBase = resolveProviderUpstream(options, provider, account);
    if (!upstreamBase) {
      lastError = `missing_upstream_for_provider_${provider}`;
      break;
    }
    const upstreamPath = resolveProviderPath(provider, req.url || '');
    const upstreamUrl = `${upstreamBase}${upstreamPath}`;
    if (provider === 'codex' && typeof refreshCodexAccessToken === 'function') {
      try {
        await refreshCodexAccessToken(account, {
          force: false,
          timeoutMs: options.upstreamTimeoutMs,
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        }, {
          fetchWithTimeout
        });
      } catch (_error) {}
    }
    const accessToken = sanitizeAccessToken(account.accessToken);
    if (!accessToken) {
      markProxyAccountFailure(account, 'invalid_access_token', cooldownMs, options.failureThreshold);
      lastError = `invalid_access_token_account_${account.id}`;
      continue;
    }
    try {
      if (
        provider === 'gemini'
        && method === 'POST'
        && String(req.url || '').startsWith('/v1/chat/completions')
        && typeof fetchGeminiCodeAssistChatCompletion === 'function'
      ) {
        try {
          const streamMode = !!(requestJson && requestJson.stream);
          if (streamMode && typeof fetchGeminiCodeAssistChatCompletionStream === 'function') {
            try {
              const upstreamStream = await fetchGeminiCodeAssistChatCompletionStream(
                options,
                account,
                requestJson || {},
                options.upstreamTimeoutMs
              );
              streamTransport = 'upstream_sse';
              const id = `chatcmpl-${Date.now()}`;
              const created = Math.floor(Date.now() / 1000);
              let model = String(requestJson && requestJson.model || 'unknown').trim() || 'unknown';
              let finished = false;

              res.statusCode = 200;
              res.setHeader('content-type', 'text/event-stream; charset=utf-8');
              res.setHeader('cache-control', 'no-cache');
              res.setHeader('connection', 'keep-alive');
              res.setHeader('x-aih-server-account-id', account.id);
              if (account.email) res.setHeader('x-aih-server-account-email', account.email);
              res.write(`data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
              })}\n\n`);

              for await (const piece of upstreamStream) {
                const modelFromPiece = String(piece && piece.model || '').trim();
                if (modelFromPiece) model = modelFromPiece;
                const candidates = Array.isArray(piece && piece.candidates) ? piece.candidates : [];
                const toolCallsByCandidate = Array.isArray(piece && piece.toolCallsByCandidate)
                  ? piece.toolCallsByCandidate
                  : [];
                for (let candidateIdx = 0; candidateIdx < candidates.length; candidateIdx += 1) {
                  const candidate = candidates[candidateIdx];
                  const toolCalls = Array.isArray(toolCallsByCandidate[candidateIdx])
                    ? toolCallsByCandidate[candidateIdx]
                    : [];
                  if (toolCalls.length > 0) {
                    const normalizedToolCalls = toolCalls.map((toolCall, index) => ({
                      index,
                      id: String(toolCall && toolCall.id || `call_${index + 1}`),
                      type: 'function',
                      function: {
                        name: String(
                          toolCall
                          && toolCall.function
                          && toolCall.function.name
                          || ''
                        ),
                        arguments: String(
                          toolCall
                          && toolCall.function
                          && toolCall.function.arguments
                          || '{}'
                        )
                      }
                    }));
                    res.write(`data: ${JSON.stringify({
                      id,
                      object: 'chat.completion.chunk',
                      created,
                      model,
                      choices: [{ index: 0, delta: { tool_calls: normalizedToolCalls }, finish_reason: null }]
                    })}\n\n`);
                  }
                  const parts = Array.isArray(candidate && candidate.content && candidate.content.parts)
                    ? candidate.content.parts
                    : [];
                  const text = parts
                    .map((part) => String(part && part.text || ''))
                    .join('');
                  if (text) {
                    res.write(`data: ${JSON.stringify({
                      id,
                      object: 'chat.completion.chunk',
                      created,
                      model,
                      choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
                    })}\n\n`);
                  }
                  const finishReasonRaw = String(candidate && candidate.finishReason || '').trim().toUpperCase();
                  if (!finished && finishReasonRaw) {
                    let finishReason = mapGeminiFinishReason(finishReasonRaw);
                    if (toolCalls.length > 0 && finishReason !== 'length') {
                      finishReason = 'tool_calls';
                    }
                    res.write(`data: ${JSON.stringify({
                      id,
                      object: 'chat.completion.chunk',
                      created,
                      model,
                      choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
                    })}\n\n`);
                    finished = true;
                  }
                }
              }

              if (!finished) {
                res.write(`data: ${JSON.stringify({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                })}\n\n`);
              }
              res.write('data: [DONE]\n\n');
              res.end();

              markProxyAccountSuccess(account);
              state.metrics.totalSuccess += 1;
              state.metrics.providerSuccess[provider] = Number(state.metrics.providerSuccess[provider] || 0) + 1;
              if (options.logRequests) {
                appendProxyRequestLog({
                  at: new Date().toISOString(),
                  requestId: requestMeta && requestMeta.requestId,
                  route: routeKey,
                  provider,
                  accountId: account.id,
                  status: 200,
                  streamRequested,
                  streamTransport,
                  durationMs: Date.now() - requestStartedAt
                });
              }
              return;
            } catch (streamError) {
              const streamErrorCode = String(streamError && streamError.code || '').trim().toUpperCase();
              const canFallbackToBuffered = streamErrorCode === 'HTTP_400'
                || streamErrorCode === 'HTTP_404'
                || streamErrorCode === 'HTTP_405'
                || streamErrorCode === 'HTTP_501';
              if (!canFallbackToBuffered) throw streamError;
            }
          }

          const payload = await fetchGeminiCodeAssistChatCompletion(options, account, requestJson || {}, options.upstreamTimeoutMs);
          if (streamMode) {
            streamTransport = 'buffered_fallback';
            const id = String(payload && payload.id || `chatcmpl-${Date.now()}`).trim();
            const created = Number(payload && payload.created) || Math.floor(Date.now() / 1000);
            const model = String(payload && payload.model || 'unknown').trim();
            const text = String(
              payload
              && Array.isArray(payload.choices)
              && payload.choices[0]
              && payload.choices[0].message
              && payload.choices[0].message.content
              || ''
            );
            const toolCalls = (
              payload
              && Array.isArray(payload.choices)
              && payload.choices[0]
              && payload.choices[0].message
              && Array.isArray(payload.choices[0].message.tool_calls)
            ) ? payload.choices[0].message.tool_calls : [];
            const finishReason = String(
              payload
              && Array.isArray(payload.choices)
              && payload.choices[0]
              && payload.choices[0].finish_reason
              || (toolCalls.length > 0 ? 'tool_calls' : 'stop')
            ).trim() || (toolCalls.length > 0 ? 'tool_calls' : 'stop');
            res.statusCode = 200;
            res.setHeader('content-type', 'text/event-stream; charset=utf-8');
            res.setHeader('cache-control', 'no-cache');
            res.setHeader('connection', 'keep-alive');
            res.setHeader('x-aih-server-account-id', account.id);
            if (account.email) res.setHeader('x-aih-server-account-email', account.email);
            const chunks = [{
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
            }];
            if (text) {
              chunks.push({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
              });
            }
            if (toolCalls.length > 0) {
              const normalizedToolCalls = toolCalls.map((toolCall, index) => ({
                index,
                id: String(toolCall && toolCall.id || `call_${index + 1}`),
                type: 'function',
                function: {
                  name: String(
                    toolCall
                    && toolCall.function
                    && toolCall.function.name
                    || ''
                  ),
                  arguments: String(
                    toolCall
                    && toolCall.function
                    && toolCall.function.arguments
                    || '{}'
                  )
                }
              }));
              chunks.push({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { tool_calls: normalizedToolCalls }, finish_reason: null }]
              });
            }
            chunks.push({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
            });
            chunks.forEach((item) => {
              res.write(`data: ${JSON.stringify(item)}\n\n`);
            });
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            streamTransport = 'non_stream';
            const raw = Buffer.from(JSON.stringify(payload));
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.setHeader('x-aih-server-account-id', account.id);
            if (account.email) res.setHeader('x-aih-server-account-email', account.email);
            res.setHeader('content-length', raw.length);
            res.end(raw);
          }

          markProxyAccountSuccess(account);
          state.metrics.totalSuccess += 1;
          state.metrics.providerSuccess[provider] = Number(state.metrics.providerSuccess[provider] || 0) + 1;
          if (options.logRequests) {
            appendProxyRequestLog({
              at: new Date().toISOString(),
              requestId: requestMeta && requestMeta.requestId,
              route: routeKey,
              provider,
              accountId: account.id,
              status: 200,
              streamRequested,
              streamTransport,
              durationMs: Date.now() - requestStartedAt
            });
          }
          return;
        } catch (codeAssistError) {
          if (String(codeAssistError && codeAssistError.code || '').trim() !== 'GEMINI_CODE_ASSIST_NOT_APPLICABLE') {
            const detail = describeUpstreamError(codeAssistError);
            lastError = detail;
            const errorCode = String(codeAssistError && codeAssistError.code || '').trim().toUpperCase();
            if (
              errorCode === 'HTTP_400'
              || errorCode === 'HTTP_401'
              || errorCode === 'HTTP_403'
              || errorCode === 'HTTP_404'
              || errorCode === 'HTTP_429'
            ) {
              if (errorCode === 'HTTP_404') finalStatusCode = 404;
              else if (errorCode === 'HTTP_400') finalStatusCode = 400;
              else if (errorCode === 'HTTP_401') finalStatusCode = 401;
              else if (errorCode === 'HTTP_403') finalStatusCode = 403;
              else finalStatusCode = 429;
              continue;
            }
            if (detail.includes('timeout')) state.metrics.totalTimeouts += 1;
            markProxyAccountFailure(account, detail, cooldownMs, options.failureThreshold);
            finalStatusCode = 502;
            continue;
          }
        }
      }

      const headers = {};
      Object.entries(req.headers || {}).forEach(([k, v]) => {
        const key = String(k || '').toLowerCase();
        if (shouldSkipForwardHeader(k)) return;
        const normalized = normalizeHeaderValue(v);
        if (!normalized) return;
        if (!isSafeHeaderValue(normalized)) return;
        headers[key] = normalized;
      });
      headers.authorization = `Bearer ${accessToken}`;
      headers['x-aih-account-id'] = account.id;
      headers['x-aih-account-email'] = account.email || '';

      const upstreamRes = await fetchWithTimeout(upstreamUrl, {
        method,
        headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : bodyBuffer
      }, options.upstreamTimeoutMs, {
        proxyUrl: options.proxyUrl,
        noProxy: options.noProxy
      });

      if (upstreamRes.status === 401 || upstreamRes.status === 403) {
        const accountId = String(account.id || '');
        const allowRefreshRetry = (
          provider === 'codex'
          && typeof refreshCodexAccessToken === 'function'
          && !forcedRefreshRetryUsed.has(accountId)
        );
        if (allowRefreshRetry) {
          let refreshResult = null;
          try {
            refreshResult = await refreshCodexAccessToken(account, {
              force: true,
              timeoutMs: options.upstreamTimeoutMs,
              proxyUrl: options.proxyUrl,
              noProxy: options.noProxy
            }, {
              fetchWithTimeout
            });
          } catch (_error) {
            refreshResult = null;
          }
          if (refreshResult && refreshResult.ok && refreshResult.refreshed) {
            forcedRefreshRetryUsed.add(accountId);
            attemptedIds.delete(accountId);
            continue;
          }
        }
        markProxyAccountFailure(account, `upstream_${upstreamRes.status}`, cooldownMs, options.failureThreshold);
        lastError = `upstream_${upstreamRes.status}_account_${account.id}`;
        continue;
      }

      const raw = Buffer.from(await upstreamRes.arrayBuffer());
      const upstreamContentType = String(upstreamRes.headers.get('content-type') || '').toLowerCase();
      if (streamRequested) {
        streamTransport = upstreamContentType.includes('text/event-stream')
          ? 'upstream_sse'
          : 'passthrough_raw';
      } else {
        streamTransport = 'non_stream';
      }
      res.statusCode = upstreamRes.status;
      upstreamRes.headers.forEach((value, key) => {
        const low = String(key || '').toLowerCase();
        if (low === 'transfer-encoding') return;
        if (low === 'content-length') return;
        res.setHeader(key, value);
      });
      res.setHeader('x-aih-server-account-id', account.id);
      if (account.email) res.setHeader('x-aih-server-account-email', account.email);
      res.setHeader('content-length', raw.length);
      res.end(raw);

      markProxyAccountSuccess(account);
      state.metrics.totalSuccess += 1;
      state.metrics.providerSuccess[provider] = Number(state.metrics.providerSuccess[provider] || 0) + 1;
      if (options.logRequests) {
        appendProxyRequestLog({
          at: new Date().toISOString(),
          requestId: requestMeta && requestMeta.requestId,
          route: routeKey,
          provider,
          accountId: account.id,
          status: upstreamRes.status,
          streamRequested,
          streamTransport,
          durationMs: Date.now() - requestStartedAt
        });
      }
      return;
    } catch (e) {
      const detail = describeUpstreamError(e);
      if (detail.includes('timeout')) state.metrics.totalTimeouts += 1;
      markProxyAccountFailure(account, detail, cooldownMs, options.failureThreshold);
      lastError = detail;
      if (isGlobalNetworkFailure(e)) {
        lastError = withNetworkHint(detail, resolveProviderUpstream(options, provider, account));
        break;
      }
    }
  }

  state.metrics.totalFailures += 1;
  state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
  pushMetricError(state.metrics, routeKey, provider, lastError);
  if (options.logRequests) {
      appendProxyRequestLog({
        at: new Date().toISOString(),
        requestId: requestMeta && requestMeta.requestId,
        route: routeKey,
        provider,
        status: finalStatusCode,
        error: lastError,
        streamRequested,
        streamTransport,
        durationMs: Date.now() - requestStartedAt
      });
  }
  writeJson(res, finalStatusCode, { ok: false, error: 'upstream_failed', detail: lastError });
}

module.exports = {
  handleUpstreamModels,
  handleUpstreamPassthrough
};
