'use strict';

const { resolveRequestProvider, normalizeExplicitProvider } = require('./router');
const { isLoopbackUrl } = require('./http-utils');
const { __private: httpUtilsPrivate } = require('./http-utils');
const { classifyUpstreamFailure, describeError } = require('./upstream-failure-policy');
const { touchAccountFailureState } = require('./account-runtime-state');
const { runWithAccountAttempts } = require('./request-orchestrator');
const {
  buildNoAvailableAccountResponse,
  hasUnavailableReason
} = require('./account-availability');
const { appendAccountRetryFailureLog } = require('./diagnostic-log');
const {
  discoverProviderModels,
  buildModelDiscoverySignature
} = require('./provider-model-discovery');

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
const isCodeAssistProvider = httpUtilsPrivate && typeof httpUtilsPrivate.isCodeAssistProvider === 'function'
  ? httpUtilsPrivate.isCodeAssistProvider
  : (provider) => provider === 'gemini' || provider === 'agy';

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
  return describeError(error);
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
  if (provider === 'agy') {
    const fromAccount = String(account && account.baseUrl || '').trim();
    return (fromAccount || String(options && options.agyBaseUrl || '').trim()).replace(/\/+$/, '');
  }
  if (provider === 'claude') {
    const fromAccount = String(account && account.baseUrl || '').trim();
    return (fromAccount || String(options && options.claudeBaseUrl || '').trim()).replace(/\/+$/, '');
  }
  if (provider === 'codex') {
    const fromAccount = (
      account
      && (account.apiKeyMode || account.authType === 'api-key')
      && String(account.openaiBaseUrl || '').trim()
    ) || '';
    return (fromAccount || String(options && options.codexBaseUrl || '').trim()).replace(/\/+$/, '');
  }
  return String(options && options.codexBaseUrl || '').trim().replace(/\/+$/, '');
}

function baseUrlEndsWithPath(baseUrl, pathSuffix) {
  const normalizedBase = String(baseUrl || '').trim().toLowerCase().replace(/\/+$/, '');
  const normalizedSuffix = String(pathSuffix || '').trim().toLowerCase().replace(/^\/+/, '');
  if (!normalizedBase || !normalizedSuffix) return false;
  return normalizedBase.endsWith(`/${normalizedSuffix}`);
}

function resolveProviderPath(provider, reqUrl, upstreamBase) {
  const rawPath = String(reqUrl || '').trim() || '/';
  if (provider === 'claude' && rawPath.startsWith('/v1/')) {
    return baseUrlEndsWithPath(upstreamBase, 'v1') ? rawPath.slice(3) : rawPath;
  }
  if (provider === 'claude' && rawPath === '/v1') {
    return baseUrlEndsWithPath(upstreamBase, 'v1') ? '/' : rawPath;
  }
  if ((provider === 'gemini' || provider === 'agy' || provider === 'claude' || provider === 'codex') && rawPath.startsWith('/v1/')) {
    return rawPath.slice(3);
  }
  if ((provider === 'gemini' || provider === 'agy' || provider === 'claude' || provider === 'codex') && rawPath === '/v1') {
    return '/';
  }
  return rawPath;
}

function isAnthropicCompatibleBaseUrl(baseUrl) {
  const text = String(baseUrl || '').trim().toLowerCase().replace(/\/+$/, '');
  return text.includes('/apps/anthropic');
}

function isClaudeMessagesPath(pathname) {
  const value = String(pathname || '').trim();
  return value === '/messages' || value === '/v1/messages';
}

function isOpenAIChatCompletionsPath(pathname) {
  const value = String(pathname || '').trim();
  return value === '/chat/completions' || value === '/v1/chat/completions';
}

function applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, defaultThreshold) {
  if (!account || !policy || !policy.shouldMarkFailure) return;
  touchAccountFailureState(account, policy);
  const threshold = Number.isFinite(Number(policy.failureThreshold)) && Number(policy.failureThreshold) > 0
    ? Number(policy.failureThreshold)
    : Math.max(1, Number(defaultThreshold) || 1);
  markProxyAccountFailure(
    account,
    policy.failureReason || policy.detail || policy.kind || 'upstream_failed',
    policy.cooldownMs || 0,
    threshold
  );
}

function sendRawUpstreamResponse(res, upstreamRes, raw, account, streamRequested) {
  res.statusCode = upstreamRes.status;
  upstreamRes.headers.forEach((value, key) => {
    const low = String(key || '').toLowerCase();
    if (low === 'transfer-encoding' || low === 'content-length') return;
    res.setHeader(key, value);
  });
  res.setHeader('x-aih-server-account-id', account.id);
  if (account.email) res.setHeader('x-aih-server-account-email', account.email);
  if (!streamRequested) {
    res.setHeader('content-length', raw.length);
  }
  res.end(raw);
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

  const ttl = Math.max(1000, Number(options.modelsCacheTtlMs) || 300000);
  const candidateLimit = Math.max(1, Number(options.modelsProbeAccounts) || 2);
  const providerMode = options && options.provider || 'auto';
  const signature = `${buildModelDiscoverySignature(state, {
    providerMode,
    includeCodex: false
  })}|limit=${candidateLimit}`;
  const now = Date.now();
  if (
    state.modelsCache.updatedAt > 0
    && now - state.modelsCache.updatedAt < ttl
    && Array.isArray(state.modelsCache.ids)
    && state.modelsCache.signature === signature
  ) {
    const payload = buildOpenAIModelsList(state.modelsCache.ids.length > 0 ? state.modelsCache.ids : FALLBACK_MODELS);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
    return;
  }

  const probeTimeout = Math.min(4000, Number(options.upstreamTimeoutMs) || 8000);
  const discovery = await discoverProviderModels({
    state,
    options,
    fetchModelsForAccount,
    providerMode,
    includeCodex: false,
    accountLimit: candidateLimit,
    timeoutMs: probeTimeout
  });
  const ids = discovery.ids;
  state.modelsCache = {
    updatedAt: now,
    ids,
    byProvider: discovery.byProvider,
    byAccount: discovery.byAccount,
    sourceCount: discovery.sourceCount,
    scannedAccounts: discovery.scannedAccounts,
    firstError: discovery.firstError,
    source: discovery.source,
    signature
  };
  const payload = buildOpenAIModelsList(ids.length > 0 ? ids : FALLBACK_MODELS);
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (ids.length === 0 && discovery.firstError) {
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

  const requestedAccountId = String(
    req
    && req.headers
    && (req.headers['x-account-id'] || req.headers['X-Account-Id'])
    || ''
  ).trim();
  const effectiveProvider = normalizeExplicitProvider(requestMeta && requestMeta.effectiveProvider);
  const provider = effectiveProvider || (typeof deps.resolveRequestProvider === 'function'
    ? deps.resolveRequestProvider(options, requestJson || {}, req && req.headers, state)
    : resolveRequestProvider(options, requestJson || {}, req && req.headers, state));
  if (!state.metrics.providerCounts || typeof state.metrics.providerCounts !== 'object') state.metrics.providerCounts = {};
  if (!state.metrics.providerSuccess || typeof state.metrics.providerSuccess !== 'object') state.metrics.providerSuccess = {};
  if (!state.metrics.providerFailures || typeof state.metrics.providerFailures !== 'object') state.metrics.providerFailures = {};
  state.metrics.providerCounts[provider] = Number(state.metrics.providerCounts[provider] || 0) + 1;
  const streamRequested = !!(requestJson && requestJson.stream);
  let streamTransport = streamRequested ? 'unknown' : 'non_stream';
  let lastError = '';
  let finalStatusCode = 502;
  const codeAssistProvider = isCodeAssistProvider(provider);
  const codeAssistSessionMapKey = `${provider}SessionIdMap`;
  if (codeAssistProvider && !(state[codeAssistSessionMapKey] instanceof Map)) {
    state[codeAssistSessionMapKey] = new Map();
  }
  const geminiRequestOptions = codeAssistProvider
    ? {
        ...options,
        provider,
        sessionKey: String(requestMeta && requestMeta.sessionKey || '').trim(),
        geminiSessionIdMap: state[codeAssistSessionMapKey],
        geminiSessionIdMapTtlMs: state.sessionAffinity && state.sessionAffinity.ttlMs,
        geminiSessionIdMapMaxEntries: state.sessionAffinity && state.sessionAffinity.maxEntries
      }
    : options;
  const providerPool = Array.isArray(state.accounts && state.accounts[provider]) ? state.accounts[provider] : [];
  const pool = requestedAccountId
    ? providerPool.filter((account) => String(account && account.id || '') === requestedAccountId)
    : providerPool;
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
  const forcedRefreshRetryUsed = new Set();
  const orchestration = await runWithAccountAttempts({
    pool,
    maxAttempts,
    chooseServerAccount,
    cursorState: state.cursors,
    cursorKey: provider,
    provider,
    sessionKey: (requestMeta && requestMeta.sessionKey) || '',
    onAttempt: async (account, control) => {
      const upstreamBase = resolveProviderUpstream(options, provider, account);
      if (!upstreamBase) {
        lastError = `missing_upstream_for_provider_${provider}`;
        control.setLastError(lastError);
        return { action: 'break' };
      }
      if (isLoopbackUrl(upstreamBase, options.port)) {
        lastError = 'infinite_loop_detected';
        control.setLastError(lastError);
        return { action: 'break' };
      }
      const upstreamPath = resolveProviderPath(provider, req.url || '', upstreamBase);
      const upstreamUrl = `${upstreamBase}${upstreamPath}`;
      let geminiCodeAssistDiagnostic = null;
      const accountGeminiRequestOptions = codeAssistProvider
        ? {
            ...geminiRequestOptions,
            appendGeminiCodeAssistDiagnostic: (diagnostic) => {
              geminiCodeAssistDiagnostic = diagnostic && typeof diagnostic === 'object' ? diagnostic : null;
            }
          }
        : geminiRequestOptions;
      const geminiDiagnosticLogFields = () => geminiCodeAssistDiagnostic ? {
        geminiCodeAssistSessionId: geminiCodeAssistDiagnostic.sessionId,
        geminiCodeAssistUserPromptId: geminiCodeAssistDiagnostic.userPromptId,
        geminiCodeAssistSessionSource: geminiCodeAssistDiagnostic.sessionSource,
        geminiCodeAssistSessionReused: geminiCodeAssistDiagnostic.sessionReused,
        geminiCodeAssistExternalSessionKeyHash: geminiCodeAssistDiagnostic.externalSessionKeyHash,
        geminiCodeAssistCreditsEnabled: geminiCodeAssistDiagnostic.creditsEnabled,
        geminiCodeAssistCreditBalance: geminiCodeAssistDiagnostic.creditBalance,
        geminiCodeAssistCreditDecisionReason: geminiCodeAssistDiagnostic.creditDecisionReason,
        geminiCodeAssistUpstreamUrl: geminiCodeAssistDiagnostic.upstreamUrl,
        geminiCodeAssistMethod: geminiCodeAssistDiagnostic.method,
        geminiCodeAssistUserAgent: geminiCodeAssistDiagnostic.userAgent
      } : {};
      const logRetryFailure = (policy, data = {}) => {
        appendAccountRetryFailureLog({
          options,
          appendProxyRequestLog,
          requestId: requestMeta && requestMeta.requestId,
          route: routeKey,
          provider,
          account,
          attempt: control.attempt + 1,
          maxAttempts,
          requestedModel: String(requestJson && requestJson.model || '').trim(),
          effectiveModel: String(requestJson && requestJson.model || '').trim(),
          streamRequested,
          streamTransport,
          upstreamUrl,
          durationMs: Date.now() - requestStartedAt,
          geminiCodeAssist: geminiCodeAssistDiagnostic || undefined,
          policy,
          ...data
        });
      };
      if (
        provider === 'claude'
        && isAnthropicCompatibleBaseUrl(upstreamBase)
        && isOpenAIChatCompletionsPath(upstreamPath)
      ) {
        lastError = 'configured_claude_base_url_uses_anthropic_compatible_endpoint_but_current_request_is_openai_chat_completions';
        control.setLastError(lastError);
        writeJson(res, 400, {
          ok: false,
          error: 'invalid_request',
          detail: '当前 claude 账号配置的 base URL 是 Anthropic 兼容端点（如 DashScope /apps/anthropic），但 /v0/webui/chat API 代理当前发送的是 OpenAI /chat/completions 协议。该组合暂不兼容；需要改走 Anthropic /v1/messages 适配，或改用 OpenAI 兼容 base URL。'
        });
        return { action: 'return' };
      }
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
        control.setLastError(lastError);
        return { action: 'retry_next' };
      }
      try {
        if (
          codeAssistProvider
          && method === 'POST'
          && String(req.url || '').startsWith('/v1/chat/completions')
          && typeof fetchGeminiCodeAssistChatCompletion === 'function'
        ) {
        try {
          const streamMode = !!(requestJson && requestJson.stream);
          if (streamMode && typeof fetchGeminiCodeAssistChatCompletionStream === 'function') {
            try {
              const upstreamStream = await fetchGeminiCodeAssistChatCompletionStream(
                accountGeminiRequestOptions,
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
                  const thoughtText = parts
                    .filter((part) => part && part.thought === true)
                    .map((part) => String(part && part.text || ''))
                    .join('');
                  if (thoughtText) {
                    res.write(`data: ${JSON.stringify({
                      id,
                      object: 'chat.completion.chunk',
                      created,
                      model,
                      choices: [{ index: 0, delta: { reasoning_content: thoughtText }, finish_reason: null }]
                    })}\n\n`);
                  }
                  const text = parts
                    .filter((part) => !(part && part.thought === true))
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
                  ...geminiDiagnosticLogFields(),
                  durationMs: Date.now() - requestStartedAt
                });
              }
              return { action: 'return' };
            } catch (streamError) {
              const streamErrorCode = String(streamError && streamError.code || '').trim().toUpperCase();
              const canFallbackToBuffered = streamErrorCode === 'HTTP_400'
                || streamErrorCode === 'HTTP_404'
                || streamErrorCode === 'HTTP_405'
                || streamErrorCode === 'HTTP_501';
              if (!canFallbackToBuffered) throw streamError;
            }
          }

          const payload = await fetchGeminiCodeAssistChatCompletion(accountGeminiRequestOptions, account, requestJson || {}, options.upstreamTimeoutMs);
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
            const reasoningText = String(
              payload
              && Array.isArray(payload.choices)
              && payload.choices[0]
              && payload.choices[0].message
              && payload.choices[0].message.reasoning_content
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
            if (reasoningText) {
              chunks.push({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { reasoning_content: reasoningText }, finish_reason: null }]
              });
            }
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
              ...geminiDiagnosticLogFields(),
              durationMs: Date.now() - requestStartedAt
            });
          }
          return { action: 'return' };
        } catch (codeAssistError) {
          if (String(codeAssistError && codeAssistError.code || '').trim() !== 'GEMINI_CODE_ASSIST_NOT_APPLICABLE') {
            const match = String(codeAssistError && codeAssistError.code || '').trim().toUpperCase().match(/^HTTP_(\d{3})$/);
            const policy = classifyUpstreamFailure({
              provider,
              statusCode: match ? Number(match[1]) : 0,
              error: codeAssistError,
              defaultCooldownMs: cooldownMs
            });
            if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
            applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold);
            logRetryFailure(policy, {
              status: policy.clientStatusCode || 502,
              upstreamUrl: geminiCodeAssistDiagnostic && geminiCodeAssistDiagnostic.upstreamUrl || upstreamUrl,
              upstreamError: codeAssistError
            });
            lastError = policy.detail;
            finalStatusCode = policy.clientStatusCode || 502;
            control.setLastError(lastError);
            if (policy.shouldRetryAnotherAccount) return { action: 'retry_next' };
            writeJson(res, finalStatusCode, { ok: false, error: 'upstream_failed', detail: lastError });
            return { action: 'return' };
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
      if (provider === 'claude' && isClaudeMessagesPath(upstreamPath)) {
        delete headers.authorization;
        headers['x-api-key'] = accessToken;
        if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
      }
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
            control.retrySameAccount();
            return { action: 'retry_same' };
          }
        }
        let authFailureBody = '';
        try {
          authFailureBody = String(Buffer.from(await upstreamRes.arrayBuffer()));
        } catch (_error) {}
        const policy = classifyUpstreamFailure({
          provider,
          statusCode: upstreamRes.status,
          headers: upstreamRes.headers,
          body: authFailureBody,
          detail: `upstream_${upstreamRes.status}_account_${account.id}`,
          defaultCooldownMs: cooldownMs
        });
        applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold);
        logRetryFailure(policy, {
          status: upstreamRes.status,
          upstreamStatus: upstreamRes.status,
          upstreamHeaders: upstreamRes.headers,
          upstreamBody: authFailureBody
        });
        lastError = policy.detail;
        finalStatusCode = policy.clientStatusCode || upstreamRes.status || 502;
        control.setLastError(lastError);
        return { action: 'retry_next' };
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
      if (upstreamRes.status >= 400) {
        const detail = `upstream_${upstreamRes.status}: ${String(raw).slice(0, 320)}`;
        const policy = classifyUpstreamFailure({
          provider,
          statusCode: upstreamRes.status,
          headers: upstreamRes.headers,
          body: String(raw),
          detail,
          defaultCooldownMs: cooldownMs
        });
        applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold);
        if (policy.shouldRetryAnotherAccount) {
          logRetryFailure(policy, {
            status: upstreamRes.status,
            upstreamStatus: upstreamRes.status,
            upstreamHeaders: upstreamRes.headers,
            upstreamBody: String(raw)
          });
        }
        lastError = policy.detail;
        finalStatusCode = policy.clientStatusCode || upstreamRes.status || 502;
        control.setLastError(lastError);
        if (policy.shouldRetryAnotherAccount) return { action: 'retry_next' };
        state.metrics.totalFailures += 1;
        state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
        pushMetricError(state.metrics, routeKey, provider, lastError);
        if (options.logRequests) {
          appendProxyRequestLog({
            at: new Date().toISOString(),
            requestId: requestMeta && requestMeta.requestId,
            route: routeKey,
            provider,
            accountId: account.id,
            status: upstreamRes.status,
            error: lastError,
            streamRequested,
            streamTransport,
            durationMs: Date.now() - requestStartedAt
          });
        }
        if (policy.shouldPassthroughToClient && raw.length > 0) {
          sendRawUpstreamResponse(res, upstreamRes, raw, account, streamRequested);
        } else {
          writeJson(res, finalStatusCode, { ok: false, error: 'upstream_failed', detail: lastError });
        }
        return { action: 'return' };
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
      return { action: 'return' };
    } catch (e) {
      const policy = classifyUpstreamFailure({
        provider,
        error: e,
        defaultCooldownMs: cooldownMs
      });
      if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
      applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold);
      logRetryFailure(policy, {
        status: policy.clientStatusCode || 502,
        upstreamError: e
      });
      lastError = policy.detail;
      finalStatusCode = policy.clientStatusCode || 502;
      if (isGlobalNetworkFailure(e)) {
        lastError = withNetworkHint(policy.detail, resolveProviderUpstream(options, provider, account));
        control.setLastError(lastError);
        return { action: 'break' };
      }
      control.setLastError(lastError);
      return { action: 'retry_next' };
    }
    }
  });

  if (orchestration.kind === 'returned') return;
  if (orchestration.kind === 'no_account') {
    state.metrics.totalFailures += 1;
    pushMetricError(state.metrics, routeKey, provider, 'no_available_account');
    const unavailable = buildNoAvailableAccountResponse(provider, pool);
    writeJson(res, unavailable.statusCode, unavailable.payload);
    return;
  }
  if (
    orchestration.kind === 'attempts_exhausted'
    && hasUnavailableReason(pool, 'auth_invalid_reauth_required')
  ) {
    state.metrics.totalFailures += 1;
    state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
    pushMetricError(state.metrics, routeKey, provider, 'no_available_account');
    const unavailable = buildNoAvailableAccountResponse(provider, pool);
    if (options.logRequests) {
      appendProxyRequestLog({
        at: new Date().toISOString(),
        requestId: requestMeta && requestMeta.requestId,
        route: routeKey,
        provider,
        status: unavailable.statusCode,
        error: lastError || 'no_available_account',
        streamRequested,
        streamTransport,
        durationMs: Date.now() - requestStartedAt
      });
    }
    writeJson(res, unavailable.statusCode, unavailable.payload);
    return;
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
