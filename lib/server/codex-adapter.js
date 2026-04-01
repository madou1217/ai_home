'use strict';

const crypto = require('node:crypto');

const CODEX_CLIENT_VERSION = '0.101.0';

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

function withNetworkHint(detail, codexBaseUrl) {
  const upstream = String(codexBaseUrl || '').trim();
  const parts = [
    String(detail || '').trim(),
    'hint: check codex upstream reachability'
  ];
  if (upstream) {
    parts.push(`codex_upstream=${upstream}`);
  }
  parts.push('proxy=AIH_SERVER_PROXY_URL/https_proxy/http_proxy');
  return parts.filter(Boolean).join(' | ');
}

function parseCodexModels(options) {
  const raw = String((options && options.codexModels) || '').trim();
  if (!raw) return [];
  const out = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return out;
}

function resolveCodexModel(requestedModel, options, state) {
  const requested = toPlainText(requestedModel || '').trim();
  if (requested) return requested;

  const cachedModels = Array.isArray(state && state.modelsCache && state.modelsCache.ids)
    ? state.modelsCache.ids.filter((item) => Boolean(toPlainText(item || '').trim()))
    : [];
  if (cachedModels.length > 0) return cachedModels[0];

  const configuredModels = parseCodexModels(options);
  if (configuredModels.length > 0) return configuredModels[0];

  return '';
}

function parseCodexModelsResponse(payload) {
  const list = Array.isArray(payload && payload.models) ? payload.models : [];
  const ids = [];
  list.forEach((model) => {
    if (!model || typeof model !== 'object') return;
    if (model.supported_in_api === false) return;
    const visibility = toPlainText(model.visibility || '').trim().toLowerCase();
    if (visibility && !['list', 'default', 'public'].includes(visibility)) return;
    const id = toPlainText(model.slug || model.id || model.model || '').trim();
    if (id) ids.push(id);
  });
  return ids;
}

async function fetchCodexModelsForAccount(ctx) {
  const { options, account, fetchWithTimeout, timeoutMs } = ctx;
  const token = sanitizeAccessToken(account && account.accessToken);
  if (!token) throw new Error('invalid_access_token');
  const base = String((options && options.codexBaseUrl) || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('invalid_codex_base_url');
  const query = `client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`;
  const url = `${base}/models?${query}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/json',
    version: CODEX_CLIENT_VERSION,
    originator: 'codex_cli_rs',
    'user-agent': `codex_cli_rs/${CODEX_CLIENT_VERSION}`
  };
  if (account && account.accountId) {
    headers['chatgpt-account-id'] = account.accountId;
  }
  const upstreamRes = await fetchWithTimeout(url, {
    method: 'GET',
    headers
  }, timeoutMs, {
    proxyUrl: options.proxyUrl,
    noProxy: options.noProxy
  });
  const rawText = await upstreamRes.text();
  if (!upstreamRes.ok) {
    throw new Error(`upstream_${upstreamRes.status}: ${toPlainText(rawText).slice(0, 320)}`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch (_error) {
    throw new Error('invalid_models_payload');
  }
  return parseCodexModelsResponse(parsed);
}

function toPlainText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function collectTextFromMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  content.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    }
  });
  return parts.join('\n');
}

function mapMessagePart(role, part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text') {
    return {
      type: role === 'assistant' ? 'output_text' : 'input_text',
      text: toPlainText(part.text || '')
    };
  }
  if (part.type === 'image_url') {
    const imageUrl = part.image_url && typeof part.image_url === 'object'
      ? toPlainText(part.image_url.url || '')
      : toPlainText(part.image_url || '');
    if (!imageUrl) return null;
    return {
      type: 'input_image',
      image_url: imageUrl
    };
  }
  return null;
}

function mapMessagesToCodexInput(messages) {
  const input = [];
  if (!Array.isArray(messages)) return input;
  messages.forEach((message) => {
    if (!message || typeof message !== 'object') return;
    const role = String(message.role || 'user').trim().toLowerCase();
    if (role === 'tool') {
      const callId = toPlainText(message.tool_call_id || '').trim();
      if (!callId) return;
      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: collectTextFromMessageContent(message.content)
      });
      return;
    }

    const codexRole = role === 'system' ? 'developer' : role;
    const content = [];
    if (typeof message.content === 'string') {
      content.push({
        type: codexRole === 'assistant' ? 'output_text' : 'input_text',
        text: message.content
      });
    } else if (Array.isArray(message.content)) {
      message.content.forEach((part) => {
        const mapped = mapMessagePart(codexRole, part);
        if (mapped) content.push(mapped);
      });
    }
    if (content.length === 0) {
      content.push({
        type: codexRole === 'assistant' ? 'output_text' : 'input_text',
        text: ''
      });
    }
    input.push({
      type: 'message',
      role: codexRole,
      content
    });

    if (codexRole === 'assistant' && Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((toolCall) => {
        if (!toolCall || toolCall.type !== 'function') return;
        const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
        input.push({
          type: 'function_call',
          call_id: toPlainText(toolCall.id || ''),
          name: toPlainText(fn.name || ''),
          arguments: toPlainText(fn.arguments || '')
        });
      });
    }
  });
  return input;
}

function mapToolsToCodex(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  tools.forEach((tool) => {
    if (!tool || tool.type !== 'function') return;
    const fn = tool.function && typeof tool.function === 'object' ? tool.function : {};
    const name = toPlainText(fn.name || '').trim();
    if (!name) return;
    out.push({
      type: 'function',
      name,
      description: toPlainText(fn.description || ''),
      parameters: fn.parameters && typeof fn.parameters === 'object'
        ? fn.parameters
        : { type: 'object', properties: {} }
    });
  });
  return out;
}

function mapResponseFormatToCodexTextFormat(responseFormat) {
  if (!responseFormat || typeof responseFormat !== 'object') return null;
  const type = String(responseFormat.type || '').trim();
  if (type === 'text') {
    return { format: { type: 'text' } };
  }
  if (type !== 'json_schema') return null;
  const schema = responseFormat.json_schema && typeof responseFormat.json_schema === 'object'
    ? responseFormat.json_schema
    : null;
  if (!schema) return null;
  return {
    format: {
      type: 'json_schema',
      name: toPlainText(schema.name || '').trim() || 'json_schema',
      strict: Boolean(schema.strict),
      schema: schema.schema && typeof schema.schema === 'object' ? schema.schema : {}
    }
  };
}

function convertOpenAIChatToCodexPayload(requestJson, forcedModel) {
  const model = toPlainText(forcedModel || requestJson && requestJson.model || '').trim();
  const codexPayload = {
    // Codex backend requires stream=true; non-stream clients are emulated by adapter side aggregation.
    stream: true,
    store: false,
    instructions: '',
    input: mapMessagesToCodexInput((requestJson && requestJson.messages) || []),
    parallel_tool_calls: true,
    reasoning: {
      effort: toPlainText(requestJson && requestJson.reasoning_effort || '').trim() || 'medium',
      summary: 'auto'
    },
    include: ['reasoning.encrypted_content']
  };
  if (model) codexPayload.model = model;

  const tools = mapToolsToCodex(requestJson && requestJson.tools);
  if (tools.length > 0) codexPayload.tools = tools;
  const textFormat = mapResponseFormatToCodexTextFormat(requestJson && requestJson.response_format);
  if (textFormat) codexPayload.text = textFormat;
  if (requestJson && requestJson.text && typeof requestJson.text === 'object') {
    const verbosity = toPlainText(requestJson.text.verbosity || '').trim();
    if (verbosity) {
      codexPayload.text = { ...(codexPayload.text || {}), verbosity };
    }
  }
  return codexPayload;
}

function parseSseEvents(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const events = [];
  let dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n').trim();
    dataLines = [];
    if (!data || data === '[DONE]') return;
    try {
      events.push(JSON.parse(data));
    } catch (_error) {}
  };
  lines.forEach((line) => {
    if (!line.trim()) {
      flush();
      return;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  });
  flush();
  return events;
}

function createChunk(state, delta, finishReason = null, usage) {
  const chunk = {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ]
  };
  if (usage && typeof usage === 'object') {
    chunk.usage = usage;
  }
  return chunk;
}

function mapUsageFromCodexResponse(response) {
  const usage = response && typeof response === 'object' ? response.usage : null;
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = Number(usage.input_tokens || 0);
  const completionTokens = Number(usage.output_tokens || 0);
  const totalTokens = Number(usage.total_tokens || promptTokens + completionTokens);
  return {
    prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completion_tokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : 0
  };
}

function convertCodexSseToOpenAIChunks(rawText, requestedModel) {
  const now = Math.floor(Date.now() / 1000);
  const state = {
    id: `chatcmpl-${Date.now()}`,
    created: now,
    model: toPlainText(requestedModel || '').trim() || 'unknown',
    roleSent: false,
    toolIndex: -1,
    hasToolCall: false
  };
  const events = parseSseEvents(rawText);
  const chunks = [];

  events.forEach((event) => {
    if (!event || typeof event !== 'object') return;
    const type = toPlainText(event.type || '').trim();
    if (!type) return;
    if (type === 'response.created' && event.response && typeof event.response === 'object') {
      if (event.response.id) state.id = toPlainText(event.response.id);
      if (Number.isFinite(Number(event.response.created_at))) state.created = Number(event.response.created_at);
      if (event.response.model) state.model = toPlainText(event.response.model);
      return;
    }
    if (type === 'response.output_text.delta') {
      if (!state.roleSent) {
        chunks.push(createChunk(state, { role: 'assistant' }));
        state.roleSent = true;
      }
      const text = toPlainText(event.delta || '');
      if (text) chunks.push(createChunk(state, { content: text }));
      return;
    }
    if (type === 'response.reasoning_summary_text.delta') {
      if (!state.roleSent) {
        chunks.push(createChunk(state, { role: 'assistant' }));
        state.roleSent = true;
      }
      const text = toPlainText(event.delta || '');
      if (text) chunks.push(createChunk(state, { reasoning_content: text }));
      return;
    }
    if (type === 'response.output_item.added' && event.item && event.item.type === 'function_call') {
      state.hasToolCall = true;
      state.toolIndex += 1;
      chunks.push(createChunk(state, {
        tool_calls: [
          {
            index: state.toolIndex,
            id: toPlainText(event.item.call_id || ''),
            type: 'function',
            function: {
              name: toPlainText(event.item.name || ''),
              arguments: ''
            }
          }
        ]
      }));
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      if (state.toolIndex < 0) return;
      const argsDelta = toPlainText(event.delta || '');
      if (!argsDelta) return;
      chunks.push(createChunk(state, {
        tool_calls: [
          {
            index: state.toolIndex,
            function: {
              arguments: argsDelta
            }
          }
        ]
      }));
      return;
    }
    if (type === 'response.completed') {
      const usage = event.response && typeof event.response === 'object'
        ? mapUsageFromCodexResponse(event.response)
        : null;
      chunks.push(createChunk(
        state,
        {},
        state.hasToolCall ? 'tool_calls' : 'stop',
        usage || undefined
      ));
    }
  });

  if (chunks.length === 0) {
    chunks.push(createChunk(state, { role: 'assistant' }));
    chunks.push(createChunk(state, {}, 'stop'));
  }

  return chunks;
}

function mapOutputMessageAndToolCalls(response) {
  const output = Array.isArray(response && response.output) ? response.output : [];
  const toolCalls = [];
  let content = '';
  let reasoning = '';
  output.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'message' && Array.isArray(item.content)) {
      item.content.forEach((part) => {
        if (!part || typeof part !== 'object') return;
        if (part.type === 'output_text') {
          content += toPlainText(part.text || '');
        }
      });
      return;
    }
    if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      item.summary.forEach((part) => {
        if (!part || typeof part !== 'object') return;
        if (part.type === 'summary_text') {
          reasoning += toPlainText(part.text || '');
        }
      });
      return;
    }
    if (item.type === 'function_call') {
      toolCalls.push({
        id: toPlainText(item.call_id || ''),
        type: 'function',
        function: {
          name: toPlainText(item.name || ''),
          arguments: toPlainText(item.arguments || '')
        }
      });
    }
  });
  return { content, reasoning, toolCalls };
}

function unwrapCodexResponseEnvelope(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.response && typeof payload.response === 'object') return payload.response;
  return payload;
}

function convertCodexResponseToOpenAICompletion(payload, requestedModel) {
  const response = unwrapCodexResponseEnvelope(payload);
  if (!response || typeof response !== 'object') return null;
  const msg = mapOutputMessageAndToolCalls(response);
  const usage = mapUsageFromCodexResponse(response) || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0
  };
  const finishReason = msg.toolCalls.length > 0 ? 'tool_calls' : 'stop';
  return {
    id: toPlainText(response.id || `chatcmpl-${Date.now()}`),
    object: 'chat.completion',
    created: Number(response.created_at) || Math.floor(Date.now() / 1000),
    model: toPlainText(response.model || requestedModel || ''),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: msg.content || '',
          reasoning_content: msg.reasoning || undefined,
          tool_calls: msg.toolCalls.length > 0 ? msg.toolCalls : undefined
        },
        finish_reason: finishReason
      }
    ],
    usage
  };
}

function generateSessionId() {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (_error) {}
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function handleCodexModels(ctx) {
  const { options, state, res, deps } = ctx;
  const { buildOpenAIModelsList, fetchWithTimeout } = deps;
  const now = Date.now();
  const ttl = Math.max(1000, Number(options.modelsCacheTtlMs) || 300000);
  const configuredModels = parseCodexModels(options);
  if (state
    && state.modelsCache
    && state.modelsCache.updatedAt > 0
    && now - state.modelsCache.updatedAt < ttl
    && Array.isArray(state.modelsCache.ids)
    && state.modelsCache.ids.length > 0) {
    const payload = buildOpenAIModelsList(state.modelsCache.ids);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
    return;
  }
  const pool = (state && state.accounts && Array.isArray(state.accounts.codex))
    ? state.accounts.codex
    : [];
  const probeCount = Math.max(1, Math.min(8, Number(options.modelsProbeAccounts) || 2));
  const candidates = pool
    .filter((account) => Date.now() >= Number(account.cooldownUntil || 0))
    .slice(0, probeCount);
  const modelSet = new Set();
  let firstError = '';
  const probeTimeout = Math.min(5000, Number(options.upstreamTimeoutMs) || 45000);
  const settled = await Promise.allSettled(
    candidates.map((account) => fetchCodexModelsForAccount({
      options,
      account,
      fetchWithTimeout,
      timeoutMs: probeTimeout
    }))
  );
  settled.forEach((result) => {
    if (result.status === 'fulfilled') {
      result.value.forEach((id) => modelSet.add(id));
      return;
    }
    if (!firstError) {
      firstError = toPlainText(result.reason && result.reason.message || result.reason).trim();
    }
  });
  const discoveredIds = Array.from(modelSet).sort();
  let finalIds = discoveredIds;
  let source = 'discovered';
  if (finalIds.length === 0) {
    const staleIds = Array.isArray(state && state.modelsCache && state.modelsCache.ids)
      ? state.modelsCache.ids.filter((item) => Boolean(toPlainText(item || '').trim()))
      : [];
    if (staleIds.length > 0) {
      finalIds = staleIds;
      source = 'stale-cache';
    } else if (configuredModels.length > 0) {
      finalIds = configuredModels;
      source = 'configured';
    }
  }
  if (finalIds.length === 0) {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      ok: false,
      error: 'models_unavailable',
      detail: firstError || 'no_models_discovered'
    }));
    return;
  }
  if (state && state.modelsCache) {
    state.modelsCache = {
      updatedAt: now,
      ids: finalIds,
      byAccount: {},
      sourceCount: discoveredIds.length > 0 ? candidates.length : 0
    };
  }
  const payload = buildOpenAIModelsList(finalIds);
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-aih-models-source', source);
  if (discoveredIds.length === 0) {
    res.setHeader('x-aih-models-fallback', '1');
    if (firstError) {
      const safeReason = toPlainText(firstError).replace(/[^\x20-\x7E]/g, ' ').trim();
      if (safeReason) {
        res.setHeader('x-aih-models-fallback-reason', safeReason.slice(0, 120));
      }
    }
  }
  res.end(JSON.stringify(payload));
}

async function handleCodexChatCompletions(ctx) {
  const {
    options,
    state,
    req,
    res,
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
    markProxyAccountFailure,
    markProxyAccountSuccess,
    appendProxyRequestLog,
    refreshCodexAccessToken
  } = deps;

  const pool = state.accounts.codex || [];
  const requestedModel = toPlainText(requestJson && requestJson.model || '').trim();
  const resolvedModel = resolveCodexModel(requestedModel, options, state);
  if (!resolvedModel) {
    writeJson(res, 400, {
      ok: false,
      error: 'invalid_request',
      detail: 'model is required and no discoverable codex model is available'
    });
    return;
  }
  const baseMaxAttempts = Math.min(
    Math.max(1, Number(options.maxAttempts) || 3),
    Math.max(1, pool.length)
  );
  const authRetryBudget = (typeof refreshCodexAccessToken === 'function' && pool.length > 0) ? 1 : 0;
  const maxAttempts = baseMaxAttempts + authRetryBudget;
  const attemptedIds = new Set();
  const forcedRefreshRetryUsed = new Set();
  let lastError = '';

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const account = chooseServerAccount(pool, state.cursors, 'codex', {
      provider: 'codex',
      sessionKey: (requestMeta && requestMeta.sessionKey) || '',
      excludeIds: attemptedIds
    });
    if (!account) {
      state.metrics.totalFailures += 1;
      pushMetricError(state.metrics, routeKey, 'codex', 'no_available_account');
      writeJson(res, 503, { ok: false, error: 'no_available_account' });
      return;
    }
    attemptedIds.add(String(account.id || ''));
    if (typeof refreshCodexAccessToken === 'function') {
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

    const codexBaseUrl = String(options.codexBaseUrl || '').trim().replace(/\/+$/, '');
    const codexUrl = `${codexBaseUrl}/responses`;
    const codexPayload = convertOpenAIChatToCodexPayload(requestJson || {}, resolvedModel);
    const clientWantsStream = Boolean(requestJson && requestJson.stream);

    try {
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
      headers['content-type'] = 'application/json';
      headers.accept = codexPayload.stream ? 'text/event-stream' : 'application/json';
      headers.connection = 'keep-alive';
      headers.version = '0.101.0';
      headers.session_id = generateSessionId();
      headers['user-agent'] = headers['user-agent'] || 'codex_cli_rs/0.101.0';
      headers.originator = headers.originator || 'codex_cli_rs';
      if (account.accountId) headers['chatgpt-account-id'] = account.accountId;
      headers['x-aih-account-id'] = account.id;
      headers['x-aih-account-email'] = account.email || '';

      const upstreamRes = await fetchWithTimeout(codexUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(codexPayload)
      }, options.upstreamTimeoutMs, {
        proxyUrl: options.proxyUrl,
        noProxy: options.noProxy
      });

      const rawText = await upstreamRes.text();
      if (upstreamRes.status === 401 || upstreamRes.status === 403) {
        const accountId = String(account.id || '');
        const allowRefreshRetry = (
          typeof refreshCodexAccessToken === 'function'
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
      if (upstreamRes.status >= 400 && upstreamRes.status < 500 && upstreamRes.status !== 429) {
        const detail = `upstream_${upstreamRes.status}: ${toPlainText(rawText).slice(0, 320)}`;
        state.metrics.totalFailures += 1;
        pushMetricError(state.metrics, routeKey, 'codex', detail);
        if (options.logRequests) {
          appendProxyRequestLog({
            at: new Date().toISOString(),
            requestId: requestMeta && requestMeta.requestId,
            route: routeKey,
            provider: 'codex',
            accountId: account.id,
            status: upstreamRes.status,
            error: detail,
            durationMs: Date.now() - requestStartedAt
          });
        }
        writeJson(res, upstreamRes.status, { ok: false, error: 'invalid_request', detail });
        return;
      }
      if (!upstreamRes.ok) {
        const detail = `upstream_${upstreamRes.status}: ${toPlainText(rawText).slice(0, 320)}`;
        markProxyAccountFailure(account, detail, cooldownMs, options.failureThreshold);
        lastError = detail;
        continue;
      }

      if (clientWantsStream) {
        const chunks = convertCodexSseToOpenAIChunks(rawText, resolvedModel);
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream; charset=utf-8');
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('connection', 'keep-alive');
        res.setHeader('x-aih-server-account-id', account.id);
        if (account.email) res.setHeader('x-aih-server-account-email', account.email);
        res.setHeader('x-aih-effective-model', resolvedModel);
        chunks.forEach((chunk) => {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        });
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        const events = parseSseEvents(rawText);
        const completed = events.find((item) => item && item.type === 'response.completed') || null;
        let parsed = completed;
        if (!parsed) {
          try {
            parsed = JSON.parse(rawText);
          } catch (_error) {
            parsed = null;
          }
        }
        const completion = convertCodexResponseToOpenAICompletion(parsed, resolvedModel);
        if (!completion) {
          markProxyAccountFailure(account, 'invalid_codex_response', cooldownMs, options.failureThreshold);
          lastError = 'invalid_codex_response';
          continue;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('x-aih-server-account-id', account.id);
        if (account.email) res.setHeader('x-aih-server-account-email', account.email);
        res.setHeader('x-aih-effective-model', resolvedModel);
        res.end(JSON.stringify(completion));
      }

      markProxyAccountSuccess(account);
      state.metrics.totalSuccess += 1;
      if (options.logRequests) {
        appendProxyRequestLog({
          at: new Date().toISOString(),
          requestId: requestMeta && requestMeta.requestId,
          route: routeKey,
          provider: 'codex',
          accountId: account.id,
          status: 200,
          durationMs: Date.now() - requestStartedAt
        });
      }
      return;
    } catch (error) {
      const detail = describeUpstreamError(error);
      if (detail.includes('timeout')) state.metrics.totalTimeouts += 1;
      markProxyAccountFailure(account, detail, cooldownMs, options.failureThreshold);
      lastError = detail;
      if (isGlobalNetworkFailure(error)) {
        lastError = withNetworkHint(detail, options.codexBaseUrl);
        break;
      }
    }
  }

  state.metrics.totalFailures += 1;
  pushMetricError(state.metrics, routeKey, 'codex', lastError);
  if (options.logRequests) {
    appendProxyRequestLog({
      at: new Date().toISOString(),
      requestId: requestMeta && requestMeta.requestId,
      route: routeKey,
      provider: 'codex',
      status: 502,
      error: lastError,
      durationMs: Date.now() - requestStartedAt
    });
  }
  writeJson(res, 502, { ok: false, error: 'upstream_failed', detail: lastError });
}

module.exports = {
  handleCodexModels,
  handleCodexChatCompletions,
  __private: {
    CODEX_CLIENT_VERSION,
    parseCodexModels,
    parseCodexModelsResponse,
    fetchCodexModelsForAccount,
    resolveCodexModel,
    convertOpenAIChatToCodexPayload,
    convertCodexSseToOpenAIChunks,
    convertCodexResponseToOpenAICompletion,
    parseSseEvents
  }
};
