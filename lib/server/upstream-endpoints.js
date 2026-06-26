'use strict';

const { resolveRequestProvider, normalizeExplicitProvider } = require('./router');
const { isLoopbackUrl } = require('./http-utils');
const { __private: httpUtilsPrivate } = require('./http-utils');
const { classifyUpstreamFailure, describeError } = require('./upstream-failure-policy');
const { applyAccountFailurePolicy } = require('./account-runtime-state');
const { runWithAccountAttempts } = require('./request-orchestrator');
const {
  buildNoAvailableAccountResponse,
  hasUnavailableReason
} = require('./account-availability');
const { appendAccountRetryFailureLog } = require('./diagnostic-log');
const { resolveOpenAIChatFinishReason } = require('./protocol-finish-reason');
const { createCanonicalRenderer } = require('./protocol-stream-pipeline');
const { anthropicMessageToCanonicalEvents } = require('./code-assist-anthropic-adapter');
const {
  PROVIDER_PROTOCOL_TRANSPORTS,
  resolveProviderProtocolRoutePlan,
  resolveProviderProtocolTransport
} = require('./provider-protocol-routing');
const {
  compactProviderProtocolPlan,
  createProviderProtocolPlan
} = require('./provider-protocol-plan');
const {
  discoverProviderModels,
  buildModelDiscoverySignature
} = require('./provider-model-discovery');
const {
  buildModelCapabilityIndex,
  getAccountRef,
  listAvailableAccountRefsForModelProvider
} = require('./model-capability-index');
const { isClaudeAuthTokenAccount } = require('../account/claude-credential');
const {
  getWebUiModelsCache
} = require('./webui-model-cache');
const {
  applyModelCatalogSettingsToEntries
} = require('./model-catalog-settings-store');
const {
  refreshStaleAgyUsageSnapshotsForPool,
  scheduleAgyUsageRefreshAfterFailure
} = require('./agy-usage-snapshot');
const {
  fetchOpenCodeChatCompletion,
  fetchOpenCodeChatCompletionStream
} = require('./opencode-server-client');
const {
  writeOpenAIChatCompletionPayloadAsSse
} = require('./openai-chat-sse');
const {
  modelIdsMatch
} = require('./model-id');

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

function buildModelListEntries(ids, settings, options = {}, fallbackModels = [], accountModels = {}) {
  const accountEntries = [];
  Object.entries(accountModels && typeof accountModels === 'object' ? accountModels : {}).forEach(([accountRef, models]) => {
    (Array.isArray(models) ? models : []).forEach((id) => {
      accountEntries.push({ id, accountRef });
    });
  });
  if (accountEntries.length > 0) {
    return applyModelCatalogSettingsToEntries(accountEntries, settings, {
      providerMode: options && options.provider
    });
  }
  const primary = applyModelCatalogSettingsToEntries(
    (Array.isArray(ids) ? ids : []).map((id) => ({ id })),
    settings,
    { providerMode: options && options.provider }
  );
  if (primary.length > 0) return primary;
  return applyModelCatalogSettingsToEntries(
    (Array.isArray(fallbackModels) ? fallbackModels : []).map((id) => ({ id })),
    settings,
    { providerMode: options && options.provider }
  );
}

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

function stripUrlQueryAndHash(value) {
  return String(value || '').trim().split(/[?#]/, 1)[0] || '';
}

function isClaudeMessagesPath(pathname) {
  const value = stripUrlQueryAndHash(pathname);
  return value === '/messages' || value === '/v1/messages';
}

function isOpenAIChatCompletionsPath(pathname) {
  const value = stripUrlQueryAndHash(pathname);
  return value === '/chat/completions' || value === '/v1/chat/completions';
}

function isGeminiGenerateContentPath(pathname) {
  const value = stripUrlQueryAndHash(pathname);
  return /^\/v1(?:beta)?\/models\/[^/]+:(?:generateContent|streamGenerateContent)$/.test(value);
}

function isGeminiStreamGenerateContentPath(pathname) {
  const value = stripUrlQueryAndHash(pathname);
  return /^\/v1(?:beta)?\/models\/[^/]+:streamGenerateContent$/.test(value);
}

function shouldUseCodeAssistAnthropicDirectTransport(requestMeta) {
  return resolveProviderProtocolTransport(requestMeta)
    === PROVIDER_PROTOCOL_TRANSPORTS.CODE_ASSIST_ANTHROPIC_DIRECT;
}

function shouldUseOpenCodeGoApiTransport(requestMeta) {
  return resolveProviderProtocolTransport(requestMeta)
    === PROVIDER_PROTOCOL_TRANSPORTS.OPENCODE_GO_API;
}

function selectAccountsForRequestModel(pool, provider, requestJson, state, options) {
  const model = String(requestJson && requestJson.model || '').trim();
  if (!model || !Array.isArray(pool) || pool.length < 1) {
    return { pool, model, filtered: false, accountRefs: [] };
  }
  const index = buildModelCapabilityIndex(state, options || {});
  const providerModels = index.providerModels && index.providerModels.get(provider);
  if (!(providerModels instanceof Set) || providerModels.size < 1) {
    return { pool, model, filtered: false, accountRefs: [], unchecked: true };
  }
  const accountRefs = listAvailableAccountRefsForModelProvider(index, model, provider);
  if (accountRefs.length < 1) {
    if (Array.from(providerModels).some((modelId) => modelIdsMatch(modelId, model))) {
      return { pool, model, filtered: false, accountRefs: [], providerCatalogOnly: true };
    }
    return { pool: [], model, filtered: true, accountRefs };
  }
  const allowed = new Set(accountRefs);
  return {
    pool: pool.filter((account) => allowed.has(getAccountRef(provider, account))),
    model,
    filtered: true,
    accountRefs
  };
}

function writeNoModelAccountResponse(input = {}) {
  const {
    writeJson,
    res,
    provider,
    routeKey,
    state,
    pushMetricError,
    requestMeta,
    requestStartedAt,
    streamRequested,
    streamTransport,
    selectedPool,
    model,
    requestedAccountId,
    appendProxyRequestLog,
    options
  } = input;
  const detail = `no available ${provider} account can serve model ${model}`;
  state.metrics.totalFailures += 1;
  state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
  pushMetricError(state.metrics, routeKey, provider, {
    message: 'no_available_account',
    error: 'no_available_account',
    accountId: requestedAccountId || ''
  });
  if (options && options.logRequests) {
    appendProxyRequestLog({
      at: new Date().toISOString(),
      requestId: requestMeta && requestMeta.requestId,
      route: routeKey,
      provider,
      status: 503,
      error: detail,
      streamRequested,
      streamTransport,
      durationMs: Date.now() - requestStartedAt
    });
  }
  writeJson(res, 503, {
    ok: false,
    error: 'no_available_account',
    detail,
    availability: {
      provider,
      model,
      total: Array.isArray(selectedPool) ? selectedPool.length : 0,
      available: 0,
      requestedAccountId: requestedAccountId || undefined
    }
  });
}

function shouldDeferAliasRuntimeFailure(requestMeta, res) {
  const fallback = requestMeta && requestMeta.aliasRuntimeFallback;
  return Boolean(
    fallback
    && fallback.enabled
    && !(res && (res.headersSent || res.writableEnded))
  );
}

function createAliasRuntimeFailureResult(input = {}) {
  const requestMeta = input.requestMeta && typeof input.requestMeta === 'object'
    ? input.requestMeta
    : {};
  const fallback = requestMeta.aliasRuntimeFallback && typeof requestMeta.aliasRuntimeFallback === 'object'
    ? requestMeta.aliasRuntimeFallback
    : {};
  const aliasResolution = requestMeta.aliasResolution && typeof requestMeta.aliasResolution === 'object'
    ? requestMeta.aliasResolution
    : {};
  return {
    ok: false,
    retryAliasCandidate: true,
    kind: 'alias_runtime_failure',
    provider: String(input.provider || fallback.provider || ''),
    model: String(input.model || fallback.model || ''),
    statusCode: Number(input.statusCode || 502),
    error: String(input.error || 'upstream_failed'),
    detail: String(input.detail || ''),
    attemptedAccountIds: Array.isArray(input.attemptedAccountIds) ? input.attemptedAccountIds : [],
    alias: {
      requestedModel: String(aliasResolution.requestedModel || fallback.requestedModel || ''),
      target: String(aliasResolution.aliasTarget || fallback.target || ''),
      id: String(aliasResolution.aliasId || fallback.candidateId || '')
    }
  };
}

function applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, defaultThreshold, model = '') {
  // Account-scoped vs model-scoped failure bookkeeping (including the transient
  // network/timeout consecutive-failure gate) lives in applyAccountFailurePolicy
  // so this path and the codex-adapter path stay consistent.
  return applyAccountFailurePolicy(account, policy, {
    markProxyAccountFailure,
    defaultThreshold,
    model
  });
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

async function pipeReadableBodyToResponse(body, res) {
  if (!body) return;
  const writeChunk = (chunk) => {
    if (chunk == null || res.writableEnded) return;
    res.write(typeof chunk === 'string' || Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        writeChunk(chunk.value);
      }
    } finally {
      if (typeof reader.releaseLock === 'function') {
        try { reader.releaseLock(); } catch (_error) {}
      }
    }
    return;
  }
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) {
      writeChunk(chunk);
    }
  }
}

function writeUpstreamSseHeaders(res, account) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-aih-server-account-id', account.id);
  if (account.email) res.setHeader('x-aih-server-account-email', account.email);
}

function writeCodeAssistAnthropicSseHeaders(res, account) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-aih-server-account-id', account.id);
  if (account.email) res.setHeader('x-aih-server-account-email', account.email);
}

function writeCanonicalEventsAsAnthropicSse(res, events, fallbackModel) {
  const renderer = createCanonicalRenderer('anthropic_messages', (chunk) => res.write(chunk), fallbackModel);
  (Array.isArray(events) ? events : []).forEach((event) => renderer.event(event));
  renderer.end();
}

// 心跳保活阈值：上游静默超过 IDLE_MS 就发一次心跳；每 TICK_MS 检查一次。
// 大文件写入时 AGY 缓冲 function call、上游可静默 30s+，必须保证任何 >~4s 的静默都有心跳。
const ANTHROPIC_STREAM_KEEPALIVE_IDLE_MS = 4000;
const ANTHROPIC_STREAM_KEEPALIVE_TICK_MS = 2000;

async function writeCanonicalEventStreamAsAnthropicSse(res, eventStream, fallbackModel) {
  const renderer = createCanonicalRenderer('anthropic_messages', (chunk) => res.write(chunk), fallbackModel);
  // 心跳保活：AGY/gemini 生成 function call（工具调用，如写文件）时不逐 token 流式，而是整段缓冲——
  // 大文件写入会出现 30s+ 的上游静默（thinking 块结束后、tool_use 块出现前）。
  // 【关键】必须发真正的 anthropic `ping` 事件，而不是 SSE 注释行(": ...")。注释行只能维持 TCP 连接，
  // 但 Claude Code 的 SSE 解析器会把注释当无事件忽略 → 应用层认为"长时间无事件" → "writing 一直卡住"。
  // anthropic 原生 API 正是在空隙里发 `event: ping`，Claude Code 会把它当作流活动来处理。
  // ping 只能在 message_start 之后发（原生协议如此），故用 started 门控。
  const PING_EVENT = 'event: ping\ndata: {"type": "ping"}\n\n';
  let started = false;
  let lastActivityAt = Date.now();
  const keepAlive = setInterval(() => {
    if (!started) return; // message_start 之前不发 ping，避免客户端解析器在首事件前收到 ping
    if (Date.now() - lastActivityAt < ANTHROPIC_STREAM_KEEPALIVE_IDLE_MS) return;
    try {
      if (!res.writableEnded) {
        res.write(PING_EVENT);
        lastActivityAt = Date.now();
      }
    } catch (_error) { /* best effort */ }
  }, ANTHROPIC_STREAM_KEEPALIVE_TICK_MS);
  if (typeof keepAlive.unref === 'function') keepAlive.unref();
  try {
    for await (const event of eventStream) {
      started = true; // 首个事件(message_start)一发出即开启 ping 心跳
      lastActivityAt = Date.now();
      renderer.event(event);
    }
    renderer.end();
  } finally {
    clearInterval(keepAlive);
  }
}

function isNonEmptyCanonicalAssistantEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.type === 'content_delta') {
    const contentType = String(event.contentType || '').trim();
    const text = String(event.text || '').trim();
    return Boolean(text && (contentType === 'text' || contentType === 'thinking'));
  }
  return event.type === 'tool_call_start';
}

function createEmptyUpstreamResponseError() {
  const error = new Error('empty_upstream_response');
  error.code = 'EMPTY_UPSTREAM_RESPONSE';
  return error;
}

async function closeAsyncIterator(iterator) {
  if (!iterator || typeof iterator.return !== 'function') return;
  try {
    await iterator.return();
  } catch (_error) { /* best effort */ }
}

async function* replayPrimedAsyncIterator(bufferedItems, iterator) {
  try {
    for (const item of bufferedItems) yield item;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await closeAsyncIterator(iterator);
  }
}

function isNonEmptyGeminiGenerateContentPiece(piece) {
  const candidates = Array.isArray(piece && piece.candidates) ? piece.candidates : [];
  return candidates.some((candidate) => {
    const content = candidate && candidate.content;
    const parts = Array.isArray(content && content.parts) ? content.parts : [];
    return parts.some((part) => {
      if (!part || typeof part !== 'object') return false;
      if (typeof part.text === 'string' && part.text.trim()) return true;
      return Boolean(part.functionCall && typeof part.functionCall === 'object');
    });
  });
}

async function requireNonEmptyGeminiGenerateContentStream(upstreamStream) {
  if (!upstreamStream || typeof upstreamStream[Symbol.asyncIterator] !== 'function') {
    throw createEmptyUpstreamResponseError();
  }
  const iterator = upstreamStream[Symbol.asyncIterator]();
  const bufferedPieces = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      throw createEmptyUpstreamResponseError();
    }
    bufferedPieces.push(next.value);
    if (isNonEmptyGeminiGenerateContentPiece(next.value)) {
      return replayPrimedAsyncIterator(bufferedPieces, iterator);
    }
  }
}

async function requireNonEmptyCanonicalEventStream(eventStream) {
  if (!eventStream || typeof eventStream[Symbol.asyncIterator] !== 'function') {
    throw createEmptyUpstreamResponseError();
  }
  const iterator = eventStream[Symbol.asyncIterator]();
  const bufferedEvents = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      throw createEmptyUpstreamResponseError();
    }
    bufferedEvents.push(next.value);
    if (isNonEmptyCanonicalAssistantEvent(next.value)) {
      return replayPrimedAsyncIterator(bufferedEvents, iterator);
    }
  }
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === 'object') || null;
}

function parseJsonPayloads(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [parsed];
  } catch (_error) {
    return [];
  }
}

function parseSseJsonPayloads(raw) {
  const text = String(raw || '');
  if (!text.includes('data:')) return [];
  const payloads = [];
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object') payloads.push(parsed);
    } catch (_error) {}
  });
  return payloads;
}

function getPayloadModel(payload) {
  const response = payload && payload.response && typeof payload.response === 'object'
    ? payload.response
    : null;
  return String(
    payload && (payload.model || payload.modelVersion || payload.model_version)
    || response && (response.model || response.modelVersion || response.model_version)
    || ''
  ).trim();
}

function extractModelUsageInputFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const response = payload.response && typeof payload.response === 'object' ? payload.response : null;
  const usageMetadata = firstObject(
    payload.usageMetadata,
    payload.usage_metadata,
    response && response.usageMetadata,
    response && response.usage_metadata
  );
  if (usageMetadata) {
    return {
      usage: usageMetadata,
      usageFormat: 'gemini',
      model: getPayloadModel(payload)
    };
  }
  const usage = firstObject(payload.usage, response && response.usage);
  if (usage) {
    return {
      usage,
      usageFormat: '',
      model: getPayloadModel(payload)
    };
  }
  return null;
}

function extractModelUsageInputFromRaw(raw) {
  const payloads = [
    ...parseSseJsonPayloads(raw),
    ...parseJsonPayloads(raw)
  ];
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const usageInput = extractModelUsageInputFromPayload(payloads[index]);
    if (usageInput) return usageInput;
  }
  return null;
}

function recordSuccessfulModelUsage(recordModelUsage, input = {}) {
  if (typeof recordModelUsage !== 'function') return;
  const usageInput = input.usage && typeof input.usage === 'object'
    ? {
        usage: input.usage,
        usageFormat: String(input.usageFormat || '').trim(),
        model: String(input.model || '').trim()
      }
    : (
        extractModelUsageInputFromPayload(input.payload)
        || extractModelUsageInputFromRaw(input.raw)
      );
  if (!usageInput || !usageInput.usage) return;
  const requestMeta = input.requestMeta && typeof input.requestMeta === 'object'
    ? input.requestMeta
    : {};
  const account = input.account && typeof input.account === 'object' ? input.account : {};
  try {
    recordModelUsage({
      provider: input.provider,
      accountId: account.id,
      requestId: requestMeta.requestId,
      sessionId: requestMeta.sessionKey,
      model: String(input.model || usageInput.model || input.requestJson && input.requestJson.model || '').trim(),
      usage: usageInput.usage,
      usageFormat: usageInput.usageFormat,
      sourceKind: String(input.sourceKind || 'server_proxy').trim(),
      timestampMs: Date.now()
    });
  } catch (_error) {
    // best effort accounting; never fail a successful upstream response
  }
}

function createModelUsageCapture() {
  let latestUsageInput = null;
  return {
    observePayload(payload) {
      const usageInput = extractModelUsageInputFromPayload(payload);
      if (usageInput) latestUsageInput = usageInput;
    },
    observeCanonicalEvent(event) {
      if (event && event.usage && typeof event.usage === 'object') {
        latestUsageInput = {
          usage: event.usage,
          usageFormat: 'anthropic',
          model: String(event.model || '').trim()
        };
      }
    },
    getUsageInput() {
      return latestUsageInput;
    }
  };
}

async function* tapCanonicalEventStream(eventStream, capture) {
  for await (const event of eventStream) {
    if (capture && typeof capture.observeCanonicalEvent === 'function') {
      capture.observeCanonicalEvent(event);
    }
    yield event;
  }
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
    FALLBACK_MODELS,
    modelCatalogSettings
  } = deps;

  const ttl = Math.max(1000, Number(options.modelsCacheTtlMs) || 300000);
  const candidateLimit = Math.max(1, Number(options.modelsProbeAccounts) || 2);
  const providerMode = options && options.provider || 'auto';
  const signature = `${buildModelDiscoverySignature(state, {
    providerMode,
    includeCodex: false
  })}|limit=${candidateLimit}`;
  const probeTimeout = Math.min(4000, Number(options.upstreamTimeoutMs) || 8000);

  const sendCachedPayload = (cacheState) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    const ids = Array.isArray(cacheState.ids) ? cacheState.ids : [];
    if (ids.length === 0 && cacheState.firstError) {
      res.setHeader('x-aih-models-fallback', '1');
    }
    res.end(JSON.stringify(buildOpenAIModelsList(buildModelListEntries(
      ids,
      modelCatalogSettings || state.modelCatalogSettings,
      options,
      FALLBACK_MODELS,
      cacheState.byAccount
    ))));
  };

  // Probe every candidate account upstream and refresh the shared cache. Slow
  // (real HTTP to each provider); callers decide whether to await it.
  const runDiscoveryAndCache = async () => {
    const discovery = await discoverProviderModels({
      state,
      options,
      fetchModelsForAccount,
      providerMode,
      includeCodex: false,
      accountLimit: candidateLimit,
      timeoutMs: probeTimeout
    });
    state.modelsCache = {
      updatedAt: Date.now(),
      ids: discovery.ids,
      byProvider: discovery.byProvider,
      byAccount: discovery.byAccount,
      sourceCount: discovery.sourceCount,
      scannedAccounts: discovery.scannedAccounts,
      firstError: discovery.firstError,
      source: discovery.source,
      signature
    };
    return state.modelsCache;
  };

  // Fire a background refresh at most once at a time (de-duped by signature),
  // so stale responses stay instant while the cache catches up.
  const scheduleBackgroundRefresh = () => {
    if (state.modelsCacheRefreshing === signature) return;
    state.modelsCacheRefreshing = signature;
    Promise.resolve()
      .then(runDiscoveryAndCache)
      .catch(() => {})
      .finally(() => {
        if (state.modelsCacheRefreshing === signature) {
          state.modelsCacheRefreshing = null;
        }
      });
  };

  const now = Date.now();
  const cache = state.modelsCache || {};
  const hasUsableCache = cache.updatedAt > 0 && Array.isArray(cache.ids);
  const isFresh = hasUsableCache
    && now - cache.updatedAt < ttl
    && cache.signature === signature;

  // Fresh: serve instantly.
  if (isFresh) {
    res.setHeader('x-aih-models-cache', 'hit');
    sendCachedPayload(cache);
    return;
  }

  // Stale (expired or signature changed) but usable: serve the old list now and
  // refresh in the background — the next request gets the updated set. This is
  // what keeps /v1/models well under 300ms in steady state.
  if (hasUsableCache && cache.ids.length > 0) {
    res.setHeader('x-aih-models-cache', 'stale');
    sendCachedPayload(cache);
    scheduleBackgroundRefresh();
    return;
  }

  // Cold start: nothing cached yet, must probe synchronously this once.
  res.setHeader('x-aih-models-cache', 'miss');
  await runDiscoveryAndCache();
  sendCachedPayload(state.modelsCache);
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
    fetchGeminiCodeAssistGenerateContent,
    fetchGeminiCodeAssistGenerateContentStream,
    fetchModelsForAccount,
    fetchCodeAssistAnthropicMessage,
    fetchCodeAssistAnthropicMessageStream,
    fetchOpenCodeChatCompletion: fetchOpenCodeChatCompletionDep,
    fetchOpenCodeChatCompletionStream: fetchOpenCodeChatCompletionStreamDep,
    markProxyAccountFailure,
    markProxyAccountSuccess,
    recordModelUsage,
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
  const streamRequested = Boolean(
    requestJson && requestJson.stream
    || isGeminiStreamGenerateContentPath(req && req.url || '')
  );
  let streamTransport = streamRequested ? 'unknown' : 'non_stream';
  let lastError = '';
  let finalStatusCode = 502;
  const providerProtocolRoute = resolveProviderProtocolRoutePlan(requestMeta);
  const providerProtocolPlan = requestMeta && requestMeta.providerProtocolPlan
    ? requestMeta.providerProtocolPlan
    : compactProviderProtocolPlan(createProviderProtocolPlan({
      route: providerProtocolRoute,
      provider,
      sourceClientProtocol: requestMeta && requestMeta.sourceClientProtocol,
      clientProtocol: requestMeta && requestMeta.clientProtocol
    }));
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
        geminiSessionIdMapMaxEntries: state.sessionAffinity && state.sessionAffinity.maxEntries,
        toolProtocolDiagnostics: true,
        sourceClientProtocol: String(
          requestMeta && requestMeta.sourceClientProtocol
          || providerProtocolPlan && providerProtocolPlan.sourceClientProtocol
          || ''
        ).trim(),
        clientProtocol: String(
          requestMeta && requestMeta.clientProtocol
          || providerProtocolPlan && providerProtocolPlan.clientProtocol
          || ''
        ).trim(),
        protocolAdapterPath: Array.isArray(requestMeta && requestMeta.protocolAdapterPath)
          ? requestMeta.protocolAdapterPath.filter(Boolean)
          : (providerProtocolPlan && Array.isArray(providerProtocolPlan.requestAdapterPath)
            ? providerProtocolPlan.requestAdapterPath.slice()
            : []),
        ...(providerProtocolPlan ? { providerProtocolPlan } : {}),
        ...(providerProtocolRoute ? { providerProtocolRoute } : {})
      }
    : options;
  const providerPoolRaw = Array.isArray(state.accounts && state.accounts[provider]) ? state.accounts[provider] : [];
  const providerPool = provider === 'claude'
    ? providerPoolRaw.filter((account) => !isClaudeAuthTokenAccount(account))
    : providerPoolRaw;
  const selectedPool = requestedAccountId
    ? providerPool.filter((account) => String(account && account.id || '') === requestedAccountId)
    : providerPool;
  if (
    selectedPool.length > 0
    && String(requestJson && requestJson.model || '').trim()
    && typeof fetchModelsForAccount === 'function'
  ) {
    await getWebUiModelsCache(state, options, {
      fetchModelsForAccount
    }).catch(() => null);
  }
  if (provider === 'agy' && selectedPool.length > 0 && String(requestJson && requestJson.model || '').trim()) {
    await refreshStaleAgyUsageSnapshotsForPool({
      pool: selectedPool,
      options,
      fs: deps.fs,
      fetchWithTimeout
    }).catch(() => null);
  }
  const modelPoolSelection = selectAccountsForRequestModel(
    selectedPool,
    provider,
    requestJson || {},
    state,
    options
  );
  const pool = modelPoolSelection.pool;
  if (modelPoolSelection.filtered && selectedPool.length > 0 && pool.length < 1) {
    if (shouldDeferAliasRuntimeFailure(requestMeta, res)) {
      return createAliasRuntimeFailureResult({
        requestMeta,
        provider,
        model: modelPoolSelection.model,
        statusCode: 503,
        error: 'no_available_account',
        detail: `no available ${provider} account can serve model ${modelPoolSelection.model}`,
        attemptedAccountIds: []
      });
    }
    writeNoModelAccountResponse({
      writeJson,
      res,
      provider,
      routeKey,
      state,
      pushMetricError,
      requestMeta,
      requestStartedAt,
      streamRequested,
      streamTransport,
      selectedPool,
      model: modelPoolSelection.model,
      requestedAccountId,
      appendProxyRequestLog,
      options
    });
    return;
  }
  const configuredMaxAttempts = Math.max(1, Number(options.maxAttempts) || 3);
  const poolSize = Math.max(1, pool.length);
  const shouldCoverCodeAssistPool = codeAssistProvider && !requestedAccountId && pool.length > 0;
  const retryMaxAttempts = shouldCoverCodeAssistPool
    ? Math.max(configuredMaxAttempts, poolSize)
    : configuredMaxAttempts;
  const baseMaxAttempts = Math.min(retryMaxAttempts, poolSize);
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
    selectionState: state,
    cursorState: state.cursors,
    cursorKey: provider,
    provider,
    model: String(requestJson && requestJson.model || '').trim(),
    strategy: state.strategy,
    sessionKey: (requestMeta && requestMeta.sessionKey) || '',
    // Last-resort: when the alias preflight found every candidate only soft
    // (model) cooled, serve through a model-cooled account instead of 503'ing.
    allowModelCooled: Boolean(requestMeta && requestMeta.allowModelCooled),
    onAttempt: async (account, control) => {
      if (shouldUseOpenCodeGoApiTransport(requestMeta)) {
        const opencodeFetch = fetchOpenCodeChatCompletionDep || fetchOpenCodeChatCompletion;
        const opencodeStreamFetch = fetchOpenCodeChatCompletionStreamDep || fetchOpenCodeChatCompletionStream;
        try {
          if (streamRequested && typeof opencodeStreamFetch === 'function') {
            try {
              const upstreamRes = await opencodeStreamFetch({
                ...options,
                cwd: requestMeta && requestMeta.cwd || process.cwd()
              }, account, requestJson || {}, options.upstreamTimeoutMs, {
                fetchWithTimeout,
                openCodeServerManager: deps.openCodeServerManager
              });
              streamTransport = 'upstream_sse';
              writeUpstreamSseHeaders(res, account);
              let streamWriteError = null;
              try {
                await pipeReadableBodyToResponse(upstreamRes && upstreamRes.body, res);
              } catch (error) {
                if (!res.headersSent && !res.writableEnded) throw error;
                streamWriteError = error;
              }
              try { if (!res.writableEnded) res.end(); } catch (_endError) { /* best effort */ }

              if (streamWriteError) {
                streamTransport = 'upstream_sse_error';
                const policy = classifyUpstreamFailure({
                  provider,
                  error: streamWriteError,
                  defaultCooldownMs: cooldownMs
                });
                if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
                applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold, String(requestJson && requestJson.model || '').trim());
                state.metrics.totalFailures += 1;
                state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
                if (options.logRequests) {
                  appendProxyRequestLog({
                    at: new Date().toISOString(),
                    requestId: requestMeta && requestMeta.requestId,
                    route: routeKey,
                    provider,
                    accountId: account.id,
                    status: 200,
                    error: policy.detail,
                    streamRequested,
                    streamTransport,
                    durationMs: Date.now() - requestStartedAt
                  });
                }
                return { action: 'return' };
              }

              recordSuccessfulModelUsage(recordModelUsage, {
                provider,
                account,
                requestMeta,
                requestJson,
                sourceKind: 'server_opencode_go_proxy'
              });
              markProxyAccountSuccess(account, { model: String(requestJson && requestJson.model || '').trim() });
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
              return { action: 'return' };
            } catch (streamError) {
              const streamErrorCode = String(streamError && streamError.code || '').trim().toUpperCase();
              if (streamErrorCode !== 'OPENCODE_STREAM_UNSUPPORTED') throw streamError;
            }
          }

          const payload = await opencodeFetch({
            ...options,
            cwd: requestMeta && requestMeta.cwd || process.cwd()
          }, account, requestJson || {}, options.upstreamTimeoutMs, {
            fetchWithTimeout,
            openCodeServerManager: deps.openCodeServerManager
          });
          streamTransport = streamRequested ? 'buffered_fallback' : 'non_stream';
          if (streamRequested) {
            writeOpenAIChatCompletionPayloadAsSse(
              res,
              payload,
              payload.model || requestJson && requestJson.model,
              { sessionId: payload.sessionId || payload.session_id }
            );
          } else {
            const raw = Buffer.from(JSON.stringify(payload));
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.setHeader('x-aih-server-account-id', account.id);
            if (account.email) res.setHeader('x-aih-server-account-email', account.email);
            res.setHeader('content-length', raw.length);
            res.end(raw);
          }
          recordSuccessfulModelUsage(recordModelUsage, {
            provider,
            account,
            requestMeta,
            requestJson,
            payload,
            sourceKind: 'server_opencode_go_proxy'
          });
          markProxyAccountSuccess(account, { model: String(requestJson && requestJson.model || '').trim() });
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
          return { action: 'return' };
        } catch (opencodeError) {
          const match = String(opencodeError && opencodeError.code || '').trim().toUpperCase().match(/^HTTP_(\d{3})$/);
          const policy = classifyUpstreamFailure({
            provider,
            statusCode: match ? Number(match[1]) : 0,
            error: opencodeError,
            defaultCooldownMs: cooldownMs
          });
          if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
          applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold, String(requestJson && requestJson.model || '').trim());
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
            upstreamUrl: 'https://opencode.ai/zen/go/v1',
            upstreamError: opencodeError,
            status: policy.clientStatusCode || 502,
            durationMs: Date.now() - requestStartedAt,
            policy
          });
          lastError = policy.detail;
          finalStatusCode = policy.clientStatusCode || 502;
          control.setLastError(lastError);
          return policy.shouldRetryAnotherAccount ? { action: 'retry_next' } : { action: 'break' };
        }
      }
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
              if (!diagnostic || typeof diagnostic !== 'object') return;
              const previousStreamToolDiagnostics = Array.isArray(
                geminiCodeAssistDiagnostic && geminiCodeAssistDiagnostic.streamToolDiagnostics
              )
                ? geminiCodeAssistDiagnostic.streamToolDiagnostics
                : [];
              const nextStreamToolDiagnostics = Array.isArray(diagnostic.streamToolDiagnostics)
                ? [...previousStreamToolDiagnostics, ...diagnostic.streamToolDiagnostics].slice(-20)
                : previousStreamToolDiagnostics;
              geminiCodeAssistDiagnostic = {
                ...(geminiCodeAssistDiagnostic || {}),
                ...diagnostic,
                ...(nextStreamToolDiagnostics.length > 0 ? { streamToolDiagnostics: nextStreamToolDiagnostics } : {})
              };
            }
          }
        : geminiRequestOptions;
      const geminiDiagnosticLogFields = () => geminiCodeAssistDiagnostic ? {
        geminiCodeAssistSessionId: geminiCodeAssistDiagnostic.sessionId,
        geminiCodeAssistUserPromptId: geminiCodeAssistDiagnostic.userPromptId,
        geminiCodeAssistRequestId: geminiCodeAssistDiagnostic.requestId,
        geminiCodeAssistRequestType: geminiCodeAssistDiagnostic.requestType,
        geminiCodeAssistRequestEnvelope: geminiCodeAssistDiagnostic.requestEnvelope,
        geminiCodeAssistSessionSource: geminiCodeAssistDiagnostic.sessionSource,
        geminiCodeAssistSessionReused: geminiCodeAssistDiagnostic.sessionReused,
        geminiCodeAssistExternalSessionKeyHash: geminiCodeAssistDiagnostic.externalSessionKeyHash,
        geminiCodeAssistCreditsEnabled: geminiCodeAssistDiagnostic.creditsEnabled,
        geminiCodeAssistCreditBalance: geminiCodeAssistDiagnostic.creditBalance,
        geminiCodeAssistCreditDecisionReason: geminiCodeAssistDiagnostic.creditDecisionReason,
        geminiCodeAssistCreditTypesIncluded: geminiCodeAssistDiagnostic.creditTypesIncluded,
        geminiCodeAssistCreditTypesField: geminiCodeAssistDiagnostic.creditTypesField,
        geminiCodeAssistCreditTypesForced: geminiCodeAssistDiagnostic.creditTypesForced,
        geminiCodeAssistPublicModel: geminiCodeAssistDiagnostic.publicModel,
        geminiCodeAssistWireModel: geminiCodeAssistDiagnostic.wireModel,
        geminiCodeAssistUpstreamUrl: geminiCodeAssistDiagnostic.upstreamUrl,
        geminiCodeAssistMethod: geminiCodeAssistDiagnostic.method,
        geminiCodeAssistUserAgent: geminiCodeAssistDiagnostic.userAgent,
        geminiCodeAssistClientName: geminiCodeAssistDiagnostic.clientName,
        geminiCodeAssistClientVersion: geminiCodeAssistDiagnostic.clientVersion,
        geminiCodeAssistProjectHeader: geminiCodeAssistDiagnostic.projectHeader,
        geminiCodeAssistProjectHeaderRetry: geminiCodeAssistDiagnostic.projectHeaderRetry,
        geminiCodeAssistProjectHeaderRetryReason: geminiCodeAssistDiagnostic.projectHeaderRetryReason,
        geminiCodeAssistAnthropicBetaHeader: geminiCodeAssistDiagnostic.anthropicBetaHeader,
        geminiCodeAssistForceStreamForBuffered: geminiCodeAssistDiagnostic.forceStreamForBuffered,
        geminiCodeAssistClientProtocol: geminiCodeAssistDiagnostic.clientProtocol,
        geminiCodeAssistSourceClientProtocol: geminiCodeAssistDiagnostic.sourceClientProtocol,
        geminiCodeAssistRequestProtocol: geminiCodeAssistDiagnostic.requestProtocol,
        geminiCodeAssistUpstreamProtocol: geminiCodeAssistDiagnostic.upstreamProtocol,
        geminiCodeAssistRequestAdapter: geminiCodeAssistDiagnostic.requestAdapter,
        geminiCodeAssistResponseAdapter: geminiCodeAssistDiagnostic.responseAdapter,
        geminiCodeAssistProtocolAdapterPath: geminiCodeAssistDiagnostic.protocolAdapterPath,
        geminiCodeAssistProviderProtocolPlan: geminiCodeAssistDiagnostic.providerProtocolPlan,
        geminiCodeAssistResponsePolicy: geminiCodeAssistDiagnostic.responsePolicy,
        geminiCodeAssistRequestSummary: geminiCodeAssistDiagnostic.requestSummary,
        geminiCodeAssistResponseToolCalls: geminiCodeAssistDiagnostic.responseToolCalls,
        geminiCodeAssistResponseFinishReasons: geminiCodeAssistDiagnostic.responseFinishReasons,
        geminiCodeAssistStreamToolDiagnostics: geminiCodeAssistDiagnostic.streamToolDiagnostics
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
        // If a refresh_token exists the daemon will recover this account soon — skip
        // without marking a failure so the cooldown counter doesn't accumulate.
        if (!sanitizeAccessToken(account.refreshToken)) {
          markProxyAccountFailure(account, 'invalid_access_token', cooldownMs, options.failureThreshold);
        }
        lastError = `invalid_access_token_account_${account.id}`;
        control.setLastError(lastError);
        return { action: 'retry_next' };
      }
      try {
        if (
          shouldUseCodeAssistAnthropicDirectTransport(requestMeta)
          && typeof fetchCodeAssistAnthropicMessage === 'function'
        ) {
          try {
            const streamMode = !!(requestJson && requestJson.stream);
            if (streamMode && typeof fetchCodeAssistAnthropicMessageStream === 'function') {
              try {
                console.log(`[aih] Dispatching stream anthropic messages to AGY Code Assist (account: ${account.id}, model: ${requestJson && requestJson.model})`);
                const upstreamEvents = await fetchCodeAssistAnthropicMessageStream(
                  accountGeminiRequestOptions,
                  account,
                  requestJson || {},
                  options.upstreamTimeoutMs
                );
                const nonEmptyUpstreamEvents = await requireNonEmptyCanonicalEventStream(upstreamEvents);
                streamTransport = 'upstream_sse';
                writeCodeAssistAnthropicSseHeaders(res, account);
                const usageCapture = createModelUsageCapture();
                await writeCanonicalEventStreamAsAnthropicSse(
                  res,
                  tapCanonicalEventStream(nonEmptyUpstreamEvents, usageCapture),
                  requestJson && requestJson.model
                );
                res.end();

                const requestedModelId = String(requestJson && requestJson.model || '').trim();
                const capturedUsage = usageCapture.getUsageInput();
                recordSuccessfulModelUsage(recordModelUsage, {
                  provider,
                  account,
                  requestMeta,
                  requestJson,
                  usage: capturedUsage && capturedUsage.usage,
                  usageFormat: capturedUsage && capturedUsage.usageFormat,
                  model: capturedUsage && capturedUsage.model,
                  sourceKind: 'server_code_assist_proxy'
                });
                markProxyAccountSuccess(account, { model: requestedModelId });
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

            console.log(`[aih] Dispatching buffered anthropic messages to AGY Code Assist (account: ${account.id}, model: ${requestJson && requestJson.model})`);
            const payload = await fetchCodeAssistAnthropicMessage(
              accountGeminiRequestOptions,
              account,
              requestJson || {},
              options.upstreamTimeoutMs
            );
            if (streamMode) {
              streamTransport = 'buffered_fallback';
              writeCodeAssistAnthropicSseHeaders(res, account);
              writeCanonicalEventsAsAnthropicSse(
                res,
                anthropicMessageToCanonicalEvents(payload),
                requestJson && requestJson.model
              );
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

            recordSuccessfulModelUsage(recordModelUsage, {
              provider,
              account,
              requestMeta,
              requestJson,
              payload,
              sourceKind: 'server_code_assist_proxy'
            });
            markProxyAccountSuccess(account, { model: String(requestJson && requestJson.model || '').trim() });
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
            console.error(`[aih] AGY Code Assist Anthropic adapter error for account ${account.id} (${account.email || 'no-email'}):`, codeAssistError);
            const match = String(codeAssistError && codeAssistError.code || '').trim().toUpperCase().match(/^HTTP_(\d{3})$/);
            const policy = classifyUpstreamFailure({
              provider,
              statusCode: match ? Number(match[1]) : 0,
              error: codeAssistError,
              defaultCooldownMs: cooldownMs
            });
            const retryPolicy = policy.kind === 'not_found' && shouldCoverCodeAssistPool
              ? {
                  ...policy,
                  retryable: true,
                  shouldRetryAnotherAccount: true,
                  shouldPassthroughToClient: false
                }
              : policy;
            if (retryPolicy.kind === 'timeout') state.metrics.totalTimeouts += 1;
            applyFailurePolicyToAccount(account, retryPolicy, markProxyAccountFailure, options.failureThreshold, String(requestJson && requestJson.model || '').trim());
            scheduleAgyUsageRefreshAfterFailure({
              provider,
              account,
              policy: retryPolicy,
              options,
              fs: deps.fs,
              fetchWithTimeout
            });
            logRetryFailure(retryPolicy, {
              status: retryPolicy.clientStatusCode || 502,
              upstreamUrl: geminiCodeAssistDiagnostic && geminiCodeAssistDiagnostic.upstreamUrl || upstreamUrl,
              upstreamError: codeAssistError
            });
            lastError = retryPolicy.detail;
            finalStatusCode = retryPolicy.clientStatusCode || 502;
            control.setLastError(lastError);
            // 一旦已开始向客户端流式（响应头已发出），就【不能再换账号重试】：换账号会再写一遍响应头
            // → "Cannot set headers after they are sent" (ERR_HTTP_HEADERS_SENT) → 连环 502，并污染已发出的流。
            // 直接结束当前(被中断的)流，让客户端按流中断处理，避免 6 连重试 + 误导错误 + 客户端死循环。
            if (res.headersSent || res.writableEnded) {
              try { if (!res.writableEnded) res.end(); } catch (_endError) { /* best effort */ }
              return { action: 'return' };
            }
            if (retryPolicy.shouldRetryAnotherAccount) return { action: 'retry_next' };
            writeJson(res, finalStatusCode, { ok: false, error: 'upstream_failed', detail: lastError });
            return { action: 'return' };
          }
        }

        if (
          codeAssistProvider
          && method === 'POST'
          && isGeminiGenerateContentPath(req.url || '')
          && typeof fetchGeminiCodeAssistGenerateContent === 'function'
        ) {
          try {
            const streamMode = isGeminiStreamGenerateContentPath(req.url || '')
              || String(requestMeta && requestMeta.clientProtocol || '').trim() === 'gemini_stream_generate_content';
            if (streamMode && typeof fetchGeminiCodeAssistGenerateContentStream === 'function') {
              console.log(`[aih] Dispatching stream generateContent to Gemini Code Assist (account: ${account.id}, model: ${requestJson && requestJson.model})`);
              const upstreamStream = await fetchGeminiCodeAssistGenerateContentStream(
                accountGeminiRequestOptions,
                account,
                requestJson || {},
                options.upstreamTimeoutMs
              );
              const nonEmptyUpstreamStream = await requireNonEmptyGeminiGenerateContentStream(upstreamStream);
              streamTransport = 'upstream_sse';
              res.statusCode = 200;
              res.setHeader('content-type', 'text/event-stream; charset=utf-8');
              res.setHeader('cache-control', 'no-cache');
              res.setHeader('connection', 'keep-alive');
              res.setHeader('x-aih-server-account-id', account.id);
              if (account.email) res.setHeader('x-aih-server-account-email', account.email);
              const usageCapture = createModelUsageCapture();
              for await (const piece of nonEmptyUpstreamStream) {
                usageCapture.observePayload(piece);
                res.write(`data: ${JSON.stringify(piece)}\n\n`);
              }
              res.end();

              const capturedUsage = usageCapture.getUsageInput();
              recordSuccessfulModelUsage(recordModelUsage, {
                provider,
                account,
                requestMeta,
                requestJson,
                usage: capturedUsage && capturedUsage.usage,
                usageFormat: capturedUsage && capturedUsage.usageFormat,
                model: capturedUsage && capturedUsage.model,
                sourceKind: 'server_code_assist_proxy'
              });
              markProxyAccountSuccess(account, { model: String(requestJson && requestJson.model || '').trim() });
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
            }

            console.log(`[aih] Dispatching buffered generateContent to Gemini Code Assist (account: ${account.id}, model: ${requestJson && requestJson.model})`);
            const payload = await fetchGeminiCodeAssistGenerateContent(
              accountGeminiRequestOptions,
              account,
              requestJson || {},
              options.upstreamTimeoutMs
            );
            if (streamMode) {
              streamTransport = 'buffered_fallback';
              res.statusCode = 200;
              res.setHeader('content-type', 'text/event-stream; charset=utf-8');
              res.setHeader('cache-control', 'no-cache');
              res.setHeader('connection', 'keep-alive');
              res.setHeader('x-aih-server-account-id', account.id);
              if (account.email) res.setHeader('x-aih-server-account-email', account.email);
              res.write(`data: ${JSON.stringify(payload)}\n\n`);
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

            recordSuccessfulModelUsage(recordModelUsage, {
              provider,
              account,
              requestMeta,
              requestJson,
              payload,
              sourceKind: 'server_code_assist_proxy'
            });
            markProxyAccountSuccess(account, { model: String(requestJson && requestJson.model || '').trim() });
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
            console.error(`[aih] Gemini Code Assist generateContent adapter error for account ${account.id} (${account.email || 'no-email'}):`, codeAssistError);
            const match = String(codeAssistError && codeAssistError.code || '').trim().toUpperCase().match(/^HTTP_(\d{3})$/);
            const policy = classifyUpstreamFailure({
              provider,
              statusCode: match ? Number(match[1]) : 0,
              error: codeAssistError,
              defaultCooldownMs: cooldownMs
            });
            if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
            applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold, String(requestJson && requestJson.model || '').trim());
            scheduleAgyUsageRefreshAfterFailure({
              provider,
              account,
              policy,
              options,
              fs: deps.fs,
              fetchWithTimeout
            });
            logRetryFailure(policy, {
              status: policy.clientStatusCode || 502,
              upstreamUrl: geminiCodeAssistDiagnostic && geminiCodeAssistDiagnostic.upstreamUrl || upstreamUrl,
              upstreamError: codeAssistError
            });
            lastError = policy.detail;
            finalStatusCode = policy.clientStatusCode || 502;
            control.setLastError(lastError);
            // 同上：已开始流式就不能换账号重试（ERR_HTTP_HEADERS_SENT），直接结束被中断的流。
            if (res.headersSent || res.writableEnded) {
              try { if (!res.writableEnded) res.end(); } catch (_endError) { /* best effort */ }
              return { action: 'return' };
            }
            if (policy.shouldRetryAnotherAccount) return { action: 'retry_next' };
            writeJson(res, finalStatusCode, { ok: false, error: 'upstream_failed', detail: lastError });
            return { action: 'return' };
          }
        }

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
              console.log(`[aih] Dispatching stream chat completion to Gemini Code Assist (account: ${account.id}, model: ${requestJson && requestJson.model})`);
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
              let hasStreamToolCalls = false;

              res.statusCode = 200;
              res.setHeader('content-type', 'text/event-stream; charset=utf-8');
              res.setHeader('cache-control', 'no-cache');
              res.setHeader('connection', 'keep-alive');
              res.setHeader('x-aih-server-account-id', account.id);
              if (account.email) res.setHeader('x-aih-server-account-email', account.email);
              const usageCapture = createModelUsageCapture();
              res.write(`data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
              })}\n\n`);

              for await (const piece of upstreamStream) {
                usageCapture.observePayload(piece);
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
                    hasStreamToolCalls = true;
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
                    const finishReason = resolveOpenAIChatFinishReason(
                      mapGeminiFinishReason(finishReasonRaw),
                      { hasToolCalls: hasStreamToolCalls }
                    );
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
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: resolveOpenAIChatFinishReason('stop', { hasToolCalls: hasStreamToolCalls })
                  }]
                })}\n\n`);
              }
              res.write('data: [DONE]\n\n');
              res.end();

              const capturedUsage = usageCapture.getUsageInput();
              recordSuccessfulModelUsage(recordModelUsage, {
                provider,
                account,
                requestMeta,
                requestJson,
                usage: capturedUsage && capturedUsage.usage,
                usageFormat: capturedUsage && capturedUsage.usageFormat,
                model: capturedUsage && capturedUsage.model || model,
                sourceKind: 'server_code_assist_proxy'
              });
              markProxyAccountSuccess(account, { model: String(requestJson && requestJson.model || '').trim() });
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

          console.log(`[aih] Dispatching buffered chat completion to Gemini Code Assist (account: ${account.id}, model: ${requestJson && requestJson.model})`);
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
            const finishReason = resolveOpenAIChatFinishReason(String(
              payload
              && Array.isArray(payload.choices)
              && payload.choices[0]
              && payload.choices[0].finish_reason
              || (toolCalls.length > 0 ? 'tool_calls' : 'stop')
            ).trim() || (toolCalls.length > 0 ? 'tool_calls' : 'stop'), {
              hasToolCalls: toolCalls.length > 0
            });
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

          recordSuccessfulModelUsage(recordModelUsage, {
            provider,
            account,
            requestMeta,
            requestJson,
            payload,
            sourceKind: 'server_code_assist_proxy'
          });
          markProxyAccountSuccess(account, { model: String(requestJson && requestJson.model || '').trim() });
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
            console.error(`[aih] Gemini Code Assist API error for account ${account.id} (${account.email || 'no-email'}):`, codeAssistError);
            const match = String(codeAssistError && codeAssistError.code || '').trim().toUpperCase().match(/^HTTP_(\d{3})$/);
            const policy = classifyUpstreamFailure({
              provider,
              statusCode: match ? Number(match[1]) : 0,
              error: codeAssistError,
              defaultCooldownMs: cooldownMs
            });
            if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
            applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold, String(requestJson && requestJson.model || '').trim());
            scheduleAgyUsageRefreshAfterFailure({
              provider,
              account,
              policy,
              options,
              fs: deps.fs,
              fetchWithTimeout
            });
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

      console.log(`[aih] Forwarding general request to upstream: ${method} ${upstreamUrl} (account: ${account.id})`);
      const upstreamRes = await fetchWithTimeout(upstreamUrl, {
        method,
        headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : bodyBuffer
      }, options.upstreamTimeoutMs, {
        proxyUrl: options.proxyUrl,
        noProxy: options.noProxy
      });

      if (upstreamRes.status >= 400) {
        const errorText = typeof upstreamRes.clone === 'function'
          ? await upstreamRes.clone().text().catch(() => '')
          : '';
        console.error(`[aih] Upstream returned error status ${upstreamRes.status} for ${method} ${upstreamUrl}:`, errorText);
      }

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
        applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold, String(requestJson && requestJson.model || '').trim());
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
        applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold, String(requestJson && requestJson.model || '').trim());
        scheduleAgyUsageRefreshAfterFailure({
          provider,
          account,
          policy,
          options,
          fs: deps.fs,
          fetchWithTimeout
        });
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
        pushMetricError(state.metrics, routeKey, provider, {
          message: lastError,
          error: 'upstream_failed',
          accountId: account.id
        });
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

      recordSuccessfulModelUsage(recordModelUsage, {
        provider,
        account,
        requestMeta,
        requestJson,
        raw,
        sourceKind: 'server_proxy'
      });
      markProxyAccountSuccess(account, { model: String(requestJson && requestJson.model || '').trim() });
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
      applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold, String(requestJson && requestJson.model || '').trim());
      scheduleAgyUsageRefreshAfterFailure({
        provider,
        account,
        policy,
        options,
        fs: deps.fs,
        fetchWithTimeout
      });
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
    if (shouldDeferAliasRuntimeFailure(requestMeta, res)) {
      return createAliasRuntimeFailureResult({
        requestMeta,
        provider,
        model: String(requestJson && requestJson.model || '').trim(),
        statusCode: 503,
        error: 'no_available_account',
        detail: 'no_available_account',
        attemptedAccountIds: Array.from(orchestration.attemptedIds || [])
      });
    }
    state.metrics.totalFailures += 1;
    pushMetricError(state.metrics, routeKey, provider, 'no_available_account');
    const unavailable = buildNoAvailableAccountResponse(provider, pool, {
      model: String(requestJson && requestJson.model || '').trim()
    });
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
    const unavailable = buildNoAvailableAccountResponse(provider, pool, {
      model: String(requestJson && requestJson.model || '').trim()
    });
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

  if (
    orchestration.kind === 'attempts_exhausted'
    && shouldDeferAliasRuntimeFailure(requestMeta, res)
  ) {
    return createAliasRuntimeFailureResult({
      requestMeta,
      provider,
      model: String(requestJson && requestJson.model || '').trim(),
      statusCode: finalStatusCode,
      error: lastError || 'upstream_failed',
      detail: lastError,
      attemptedAccountIds: Array.from(orchestration.attemptedIds || [])
    });
  }

  state.metrics.totalFailures += 1;
  state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
  pushMetricError(state.metrics, routeKey, provider, {
    message: lastError,
    error: lastError || 'upstream_failed',
    attemptedAccountIds: Array.from(orchestration.attemptedIds || [])
  });
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
