'use strict';

const crypto = require('node:crypto');
const { isLoopbackUrl } = require('./http-utils');
const { classifyUpstreamFailure, describeError } = require('./upstream-failure-policy');
const { applyAccountFailurePolicy } = require('./account-runtime-state');
const { runWithAccountAttempts } = require('./request-orchestrator');
const {
  applyProviderProtocolParameterStrategy
} = require('./provider-request-parameter-strategy');
const {
  applyModelCatalogSettingsToEntries
} = require('./model-catalog-settings-store');
const {
  buildModelCapabilityIndex,
  getAccountRef,
  listAvailableAccountRefsForModelProvider
} = require('./model-capability-index');
const {
  buildNoAvailableAccountResponse,
  hasUnavailableReason
} = require('./account-availability');
const { appendAccountRetryFailureLog } = require('./diagnostic-log');
const {
  fetchCodexModelsForAccount,
  parseCodexModelsResponse,
  resolveCodexClientVersion,
  resolveCodexUpstreamBaseUrl
} = require('./codex-model-client');

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

function buildCodexModelListEntries(ids, settings, options = {}) {
  return applyModelCatalogSettingsToEntries(
    (Array.isArray(ids) ? ids : []).map((id) => ({ id, provider: 'codex' })),
    settings,
    { providerMode: options && options.provider }
  );
}

function buildCodexAccountModelListEntries(accountModels, settings, options = {}) {
  const entries = [];
  Object.entries(accountModels && typeof accountModels === 'object' ? accountModels : {}).forEach(([accountRef, models]) => {
    (Array.isArray(models) ? models : []).forEach((id) => {
      entries.push({ id, provider: 'codex', accountRef });
    });
  });
  if (entries.length < 1) return [];
  return applyModelCatalogSettingsToEntries(
    entries,
    settings,
    { providerMode: options && options.provider }
  );
}

function hasAccountModelEntries(accountModels) {
  return Object.values(accountModels && typeof accountModels === 'object' ? accountModels : {})
    .some((models) => Array.isArray(models) && models.length > 0);
}

function selectCodexAccountsForRequestModel(pool, model, state, options) {
  const requestedModel = toPlainText(model || '').trim();
  if (!requestedModel || !Array.isArray(pool) || pool.length < 1) {
    return { pool, filtered: false, accountRefs: [] };
  }
  const index = buildModelCapabilityIndex(state, options || {});
  const providerModels = index.providerModels && index.providerModels.get('codex');
  if (!(providerModels instanceof Set) || providerModels.size < 1) {
    return { pool, filtered: false, accountRefs: [], unchecked: true };
  }
  const accountRefs = listAvailableAccountRefsForModelProvider(index, requestedModel, 'codex');
  if (accountRefs.length < 1) {
    return { pool: [], filtered: true, accountRefs };
  }
  const allowed = new Set(accountRefs);
  return {
    pool: pool.filter((account) => allowed.has(getAccountRef('codex', account))),
    filtered: true,
    accountRefs
  };
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

function applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, defaultThreshold, model = '') {
  // Shared with the upstream-endpoints path: transient network/timeout failures
  // only cool the account after a sustained streak, never on a single blip.
  return applyAccountFailurePolicy(account, policy, {
    markProxyAccountFailure,
    defaultThreshold,
    model
  });
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

function convertOpenAIResponsesToCodexPayload(requestJson, forcedModel, options = {}) {
  const source = requestJson && typeof requestJson === 'object' ? requestJson : {};
  const payload = {};
  Object.entries(source).forEach(([key, value]) => {
    if (value === undefined) return;
    payload[key] = value;
  });
  const model = toPlainText(forcedModel || source.model || '').trim();
  if (model) payload.model = model;
  if (options.forceStream) payload.stream = true;
  return applyProviderProtocolParameterStrategy(payload, {
    provider: 'codex',
    protocol: 'openai_responses',
    model
  });
}

function parseOpenAIErrorMessage(rawText) {
  try {
    const parsed = JSON.parse(String(rawText || ''));
    const message = toPlainText(parsed && parsed.error && parsed.error.message || '').trim();
    if (message) return message;
    const detail = toPlainText(parsed && parsed.detail || parsed && parsed.message || '').trim();
    if (detail) return detail;
  } catch (_error) {}
  return toPlainText(rawText || '').trim();
}

function writeOpenAIResponsesError(res, statusCode, rawText, fallbackDetail) {
  let payload = null;
  try {
    const parsed = JSON.parse(String(rawText || ''));
    if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object') {
      payload = parsed;
    }
  } catch (_error) {
    payload = null;
  }
  if (!payload) {
    const message = parseOpenAIErrorMessage(rawText) || toPlainText(fallbackDetail || '').trim() || `upstream_${statusCode}`;
    payload = {
      error: {
        message,
        type: statusCode === 404 ? 'not_found_error' : 'invalid_request_error',
        param: null,
        code: null
      }
    };
  }
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function extractNativeCompletedResponse(rawText) {
  const events = parseSseEvents(rawText);
  const completed = events.find((item) => item && item.type === 'response.completed' && item.response);
  if (completed && completed.response && typeof completed.response === 'object') return completed.response;
  try {
    const parsed = JSON.parse(String(rawText || ''));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_error) {}
  return null;
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

function stringifyCompact(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function extractCodexFailureDetailFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const type = toPlainText(payload.type || '').trim();
  const status = toPlainText(
    payload.status
    || payload.response && payload.response.status
    || ''
  ).trim();
  const error = payload.error
    || payload.response && payload.response.error
    || payload.last_error
    || payload.response && payload.response.last_error
    || null;
  const failed = type === 'response.failed'
    || type === 'error'
    || status === 'failed'
    || Boolean(error);
  if (!failed) return '';
  return stringifyCompact(error || payload);
}

function extractCodexFailureDetail(rawText) {
  const events = parseSseEvents(rawText);
  for (const event of events) {
    const detail = extractCodexFailureDetailFromPayload(event);
    if (detail) return detail;
  }
  try {
    return extractCodexFailureDetailFromPayload(JSON.parse(String(rawText || '')));
  } catch (_error) {
    return '';
  }
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

function readEventOutputIndex(event) {
  const value = Number(event && event.output_index);
  return Number.isFinite(value) ? value : null;
}

function readToolItemId(event, item) {
  return toPlainText(
    item && item.id
    || event && event.item_id
    || ''
  ).trim();
}

function readToolCallId(event, item) {
  return toPlainText(
    item && item.call_id
    || event && event.call_id
    || ''
  ).trim();
}

function rememberToolCall(state, call, event, item) {
  const outputIndex = readEventOutputIndex(event);
  if (outputIndex !== null) state.toolCallsByOutputIndex.set(outputIndex, call);
  const itemId = readToolItemId(event, item);
  if (itemId) state.toolCallsByItemId.set(itemId, call);
  const callId = readToolCallId(event, item);
  if (callId) state.toolCallsByCallId.set(callId, call);
}

function findToolCall(state, event, item) {
  const outputIndex = readEventOutputIndex(event);
  if (outputIndex !== null && state.toolCallsByOutputIndex.has(outputIndex)) {
    return state.toolCallsByOutputIndex.get(outputIndex);
  }
  const itemId = readToolItemId(event, item);
  if (itemId && state.toolCallsByItemId.has(itemId)) return state.toolCallsByItemId.get(itemId);
  const callId = readToolCallId(event, item);
  if (callId && state.toolCallsByCallId.has(callId)) return state.toolCallsByCallId.get(callId);
  return null;
}

function ensureToolCall(state, chunks, event, item) {
  const existing = findToolCall(state, event, item);
  if (existing) return existing;
  const index = state.nextToolIndex;
  state.nextToolIndex += 1;
  state.hasToolCall = true;
  const call = {
    index,
    id: toPlainText(item && (item.call_id || item.id) || '').trim() || `call_${index + 1}`,
    name: toPlainText(item && item.name || '').trim(),
    arguments: ''
  };
  rememberToolCall(state, call, event, item);
  chunks.push(createChunk(state, {
    tool_calls: [
      {
        index: call.index,
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: ''
        }
      }
    ]
  }));
  return call;
}

function appendToolArgumentsDelta(state, chunks, call, delta) {
  const text = toPlainText(delta || '');
  if (!call || !text) return;
  call.arguments += text;
  chunks.push(createChunk(state, {
    tool_calls: [
      {
        index: call.index,
        function: {
          arguments: text
        }
      }
    ]
  }));
}

function reconcileToolArguments(state, chunks, call, finalArguments) {
  const finalText = toPlainText(finalArguments || '');
  if (!call || !finalText || finalText === call.arguments) return;
  if (!call.arguments) {
    appendToolArgumentsDelta(state, chunks, call, finalText);
    return;
  }
  if (finalText.startsWith(call.arguments)) {
    appendToolArgumentsDelta(state, chunks, call, finalText.slice(call.arguments.length));
  }
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

function extractUsageFromOpenAIChunks(chunks) {
  if (!Array.isArray(chunks)) return null;
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const usage = chunks[index] && chunks[index].usage;
    if (usage && typeof usage === 'object') return usage;
  }
  return null;
}

function extractCodexUsageFromRawResponse(rawText) {
  const events = parseSseEvents(rawText);
  const completed = events.find((item) => item && item.type === 'response.completed') || null;
  if (completed && completed.response && typeof completed.response === 'object') {
    return completed.response.usage || null;
  }
  try {
    const parsed = JSON.parse(String(rawText || ''));
    const response = unwrapCodexResponseEnvelope(parsed);
    return response && typeof response === 'object' ? response.usage || null : null;
  } catch (_error) {
    return null;
  }
}

function recordCodexModelUsage(deps, payload = {}) {
  if (!deps || typeof deps.recordModelUsage !== 'function') return;
  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : null;
  if (!usage) return;
  try {
    deps.recordModelUsage({
      provider: 'codex',
      accountId: payload.accountId,
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      model: payload.model,
      usage,
      sourceKind: 'server_codex_proxy',
      timestampMs: payload.timestampMs
    });
  } catch (_error) {
    // best effort accounting; never fail a successful upstream response
  }
}

function convertCodexSseToOpenAIChunks(rawText, requestedModel) {
  const now = Math.floor(Date.now() / 1000);
  const state = {
    id: `chatcmpl-${Date.now()}`,
    created: now,
    model: toPlainText(requestedModel || '').trim() || 'unknown',
    roleSent: false,
    nextToolIndex: 0,
    hasToolCall: false,
    toolCallsByOutputIndex: new Map(),
    toolCallsByItemId: new Map(),
    toolCallsByCallId: new Map()
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
      const call = ensureToolCall(state, chunks, event, event.item);
      reconcileToolArguments(state, chunks, call, event.item.arguments);
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      const argsDelta = toPlainText(event.delta || '');
      if (!argsDelta) return;
      const call = findToolCall(state, event, null);
      if (!call) return;
      appendToolArgumentsDelta(state, chunks, call, argsDelta);
      return;
    }
    if (type === 'response.function_call_arguments.done') {
      const call = findToolCall(state, event, null);
      reconcileToolArguments(state, chunks, call, event.arguments);
      return;
    }
    if (type === 'response.output_item.done' && event.item && event.item.type === 'function_call') {
      const call = ensureToolCall(state, chunks, event, event.item);
      reconcileToolArguments(state, chunks, call, event.item.arguments);
      return;
    }
    if (type === 'response.completed') {
      const output = Array.isArray(event.response && event.response.output) ? event.response.output : [];
      output.forEach((item, outputIndex) => {
        if (!item || item.type !== 'function_call') return;
        const call = ensureToolCall(state, chunks, { output_index: outputIndex }, item);
        reconcileToolArguments(state, chunks, call, item.arguments);
      });
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
  const { buildOpenAIModelsList, fetchWithTimeout, modelCatalogSettings } = deps;
  const now = Date.now();
  const ttl = Math.max(1000, Number(options.modelsCacheTtlMs) || 300000);
  const configuredModels = parseCodexModels(options);
  if (state
    && state.modelsCache
    && state.modelsCache.updatedAt > 0
    && now - state.modelsCache.updatedAt < ttl
    && Array.isArray(state.modelsCache.ids)
    && state.modelsCache.ids.length > 0) {
    const accountEntries = buildCodexAccountModelListEntries(
      state.modelsCache.byAccount,
      modelCatalogSettings || state.modelCatalogSettings,
      options
    );
    const payload = buildOpenAIModelsList(hasAccountModelEntries(state.modelsCache.byAccount) ? accountEntries : buildCodexModelListEntries(
      state.modelsCache.ids,
      modelCatalogSettings || state.modelCatalogSettings,
      options
    ));
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
  const byAccount = {};
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
  settled.forEach((result, index) => {
    const account = candidates[index];
    const accountRef = String(account && account.accountRef || '').trim();
    if (result.status === 'fulfilled') {
      if (accountRef) byAccount[accountRef] = result.value.slice().sort();
      result.value.forEach((id) => modelSet.add(id));
      return;
    }
    if (accountRef) byAccount[accountRef] = [];
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
      byAccount,
      sourceCount: discoveredIds.length > 0 ? candidates.length : 0
    };
  }
  const accountEntries = buildCodexAccountModelListEntries(
    byAccount,
    modelCatalogSettings || state.modelCatalogSettings,
    options
  );
  const payload = buildOpenAIModelsList(hasAccountModelEntries(byAccount) ? accountEntries : buildCodexModelListEntries(
    finalIds,
    modelCatalogSettings || state.modelCatalogSettings,
    options
  ));
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
    refreshCodexAccessToken,
    recordModelUsage
  } = deps;

  const basePool = state.accounts.codex || [];
  const requestedModel = toPlainText(requestJson && requestJson.model || '').trim();
  const resolvedModel = resolveCodexModel(requestedModel, options, state);
  const nativeResponsesMode = String(requestMeta && requestMeta.clientProtocol || '').trim() === 'openai_responses';
  if (!resolvedModel) {
    writeJson(res, 400, {
      ok: false,
      error: 'invalid_request',
      detail: 'model is required and no discoverable codex model is available'
    });
    return;
  }
  const modelPoolSelection = selectCodexAccountsForRequestModel(basePool, resolvedModel, state, options);
  const pool = modelPoolSelection.pool;
  if (modelPoolSelection.filtered && basePool.length > 0 && pool.length < 1) {
    state.metrics.totalFailures += 1;
    pushMetricError(state.metrics, routeKey, 'codex', {
      message: 'no_available_account',
      error: 'no_available_account',
      model: resolvedModel
    });
    writeJson(res, 503, {
      ok: false,
      error: 'no_available_account',
      detail: `no available codex account can serve model ${resolvedModel}`,
      availability: {
        provider: 'codex',
        model: resolvedModel,
        total: basePool.length,
        available: 0
      }
    });
    return;
  }
  const baseMaxAttempts = Math.min(
    Math.max(1, Number(options.maxAttempts) || 3),
    Math.max(1, pool.length)
  );
  const authRetryBudget = (typeof refreshCodexAccessToken === 'function' && pool.length > 0) ? 1 : 0;
  const maxAttempts = baseMaxAttempts + authRetryBudget;
  const forcedRefreshRetryUsed = new Set();
  let lastError = '';
  const orchestration = await runWithAccountAttempts({
    pool,
    maxAttempts,
    chooseServerAccount,
    selectionState: state,
    cursorState: state.cursors,
    cursorKey: 'codex',
    provider: 'codex',
    model: resolvedModel,
    strategy: state.strategy,
    sessionKey: (requestMeta && requestMeta.sessionKey) || '',
    // Last-resort: serve a soft model-cooled account rather than 503'ing when the
    // alias preflight found nothing cleanly routable (flowed via requestMeta).
    allowModelCooled: Boolean(requestMeta && requestMeta.allowModelCooled),
    onAttempt: async (account, control) => {
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
        control.setLastError(lastError);
        return { action: 'retry_next' };
      }

      const codexBaseUrl = resolveCodexUpstreamBaseUrl(options, account);
      if (isLoopbackUrl(codexBaseUrl, options.port)) {
        lastError = 'infinite_loop_detected';
        control.setLastError(lastError);
        return { action: 'break' };
      }
      const codexUrl = `${codexBaseUrl}/responses`;
      const codexPayload = nativeResponsesMode
        ? convertOpenAIResponsesToCodexPayload(requestJson || {}, resolvedModel, {
          forceStream: !(account && (account.apiKeyMode || account.authType === 'api-key'))
        })
        : convertOpenAIChatToCodexPayload(requestJson || {}, resolvedModel);
      const clientWantsStream = Boolean(requestJson && requestJson.stream);
      const logRetryFailure = (policy, data = {}) => {
        appendAccountRetryFailureLog({
          options,
          appendProxyRequestLog,
          requestId: requestMeta && requestMeta.requestId,
          route: routeKey,
          provider: 'codex',
          account,
          attempt: control.attempt + 1,
          maxAttempts,
          requestedModel,
          effectiveModel: resolvedModel,
          streamRequested: clientWantsStream,
          upstreamUrl: codexUrl,
          durationMs: Date.now() - requestStartedAt,
          policy,
          ...data
        });
      };

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
        const clientVersion = resolveCodexClientVersion(options);
        if (clientVersion) headers.version = clientVersion;
        headers.session_id = generateSessionId();
        headers['user-agent'] = headers['user-agent'] || (clientVersion ? `codex_cli_rs/${clientVersion}` : 'codex_cli_rs');
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
            control.retrySameAccount();
            return { action: 'retry_same' };
          }
        }
        const policy = classifyUpstreamFailure({
          provider: 'codex',
          statusCode: upstreamRes.status,
          headers: upstreamRes.headers,
          body: rawText,
          detail: `upstream_${upstreamRes.status}_account_${account.id}`,
          defaultCooldownMs: cooldownMs
        });
        applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold, resolvedModel);
        logRetryFailure(policy, {
          status: upstreamRes.status,
          upstreamStatus: upstreamRes.status,
          upstreamHeaders: upstreamRes.headers,
          upstreamBody: rawText
        });
        lastError = policy.detail;
        control.setLastError(lastError);
        return { action: 'retry_next' };
      }
      if (upstreamRes.status >= 400 && upstreamRes.status < 500 && upstreamRes.status !== 429) {
        const detail = `upstream_${upstreamRes.status}: ${toPlainText(rawText).slice(0, 320)}`;
        const policy = classifyUpstreamFailure({
          provider: 'codex',
          statusCode: upstreamRes.status,
          headers: upstreamRes.headers,
          body: rawText,
          detail,
          defaultCooldownMs: cooldownMs
        });
        if (policy.shouldMarkFailure || policy.shouldRetryAnotherAccount) {
          applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold, resolvedModel);
          logRetryFailure(policy, {
            status: upstreamRes.status,
            upstreamStatus: upstreamRes.status,
            upstreamHeaders: upstreamRes.headers,
            upstreamBody: rawText
          });
          lastError = policy.detail;
          control.setLastError(lastError);
          return { action: 'retry_next' };
        }
        state.metrics.totalFailures += 1;
        pushMetricError(state.metrics, routeKey, 'codex', {
          message: detail,
          error: 'invalid_request',
          accountId: account.id
        });
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
        if (nativeResponsesMode) {
          writeOpenAIResponsesError(res, upstreamRes.status, rawText, detail);
          return { action: 'return' };
        }
        writeJson(res, upstreamRes.status, { ok: false, error: 'invalid_request', detail });
        return { action: 'return' };
      }
      if (!upstreamRes.ok) {
        const detail = `upstream_${upstreamRes.status}: ${toPlainText(rawText).slice(0, 320)}`;
        const policy = classifyUpstreamFailure({
          provider: 'codex',
          statusCode: upstreamRes.status,
          headers: upstreamRes.headers,
          body: rawText,
          detail,
          defaultCooldownMs: cooldownMs
        });
        applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold, resolvedModel);
        logRetryFailure(policy, {
          status: upstreamRes.status,
          upstreamStatus: upstreamRes.status,
          upstreamHeaders: upstreamRes.headers,
          upstreamBody: rawText
        });
        lastError = policy.detail;
        control.setLastError(lastError);
        return { action: 'retry_next' };
      }

      const responseFailureDetail = extractCodexFailureDetail(rawText);
      if (responseFailureDetail) {
        const policy = classifyUpstreamFailure({
          provider: 'codex',
          error: new Error(responseFailureDetail),
          body: rawText,
          detail: responseFailureDetail,
          defaultCooldownMs: cooldownMs
        });
        applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold, resolvedModel);
        logRetryFailure(policy, {
          status: policy.clientStatusCode || 503,
          upstreamStatus: upstreamRes.status,
          upstreamHeaders: upstreamRes.headers,
          upstreamBody: rawText,
          upstreamError: responseFailureDetail
        });
        lastError = policy.detail;
        control.setLastError(lastError);
        return { action: 'retry_next' };
      }

      if (nativeResponsesMode) {
        res.statusCode = 200;
        res.setHeader('x-aih-server-account-id', account.id);
        if (account.email) res.setHeader('x-aih-server-account-email', account.email);
        res.setHeader('x-aih-effective-model', resolvedModel);
        if (clientWantsStream) {
          const nativeUsage = extractCodexUsageFromRawResponse(rawText);
          recordCodexModelUsage({ recordModelUsage }, {
            accountId: account.id,
            requestId: requestMeta && requestMeta.requestId,
            model: resolvedModel,
            usage: nativeUsage,
            timestampMs: Date.now()
          });
          res.setHeader('content-type', 'text/event-stream; charset=utf-8');
          res.setHeader('cache-control', 'no-cache');
          res.setHeader('connection', 'keep-alive');
          res.end(rawText);
        } else {
          const nativeResponse = extractNativeCompletedResponse(rawText);
          if (!nativeResponse) {
            markProxyAccountFailure(account, 'invalid_codex_response', cooldownMs, options.failureThreshold);
            logRetryFailure({
              kind: 'invalid_codex_response',
              failureReason: 'invalid_codex_response',
              detail: 'invalid_codex_response',
              clientStatusCode: 502,
              retryable: true
            }, {
              status: 502,
              upstreamStatus: upstreamRes.status,
              upstreamHeaders: upstreamRes.headers,
              upstreamBody: rawText
            });
            lastError = 'invalid_codex_response';
            control.setLastError(lastError);
            return { action: 'retry_next' };
          }
          res.setHeader('content-type', 'application/json; charset=utf-8');
          recordCodexModelUsage({ recordModelUsage }, {
            accountId: account.id,
            requestId: requestMeta && requestMeta.requestId,
            model: nativeResponse.model || resolvedModel,
            usage: nativeResponse.usage,
            timestampMs: Date.now()
          });
          res.end(JSON.stringify(nativeResponse));
        }
      } else if (clientWantsStream) {
        const chunks = convertCodexSseToOpenAIChunks(rawText, resolvedModel);
        recordCodexModelUsage({ recordModelUsage }, {
          accountId: account.id,
          requestId: requestMeta && requestMeta.requestId,
          model: resolvedModel,
          usage: extractUsageFromOpenAIChunks(chunks),
          timestampMs: Date.now()
        });
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
          logRetryFailure({
            kind: 'invalid_codex_response',
            failureReason: 'invalid_codex_response',
            detail: 'invalid_codex_response',
            clientStatusCode: 502,
            retryable: true
          }, {
            status: 502,
            upstreamStatus: upstreamRes.status,
            upstreamHeaders: upstreamRes.headers,
            upstreamBody: rawText
          });
          lastError = 'invalid_codex_response';
          control.setLastError(lastError);
          return { action: 'retry_next' };
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('x-aih-server-account-id', account.id);
        if (account.email) res.setHeader('x-aih-server-account-email', account.email);
        res.setHeader('x-aih-effective-model', resolvedModel);
        recordCodexModelUsage({ recordModelUsage }, {
          accountId: account.id,
          requestId: requestMeta && requestMeta.requestId,
          model: completion.model || resolvedModel,
          usage: completion.usage,
          timestampMs: Date.now()
        });
        res.end(JSON.stringify(completion));
      }

      markProxyAccountSuccess(account, { model: resolvedModel });
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
        return { action: 'return' };
      } catch (error) {
        const policy = classifyUpstreamFailure({
          provider: 'codex',
          error,
          defaultCooldownMs: cooldownMs
        });
        if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
        applyFailurePolicyToAccount(account, policy, markProxyAccountFailure, options.failureThreshold, resolvedModel);
        logRetryFailure(policy, {
          status: policy.clientStatusCode || 502,
          upstreamError: error
        });
        lastError = policy.detail;
        if (isGlobalNetworkFailure(error)) {
          lastError = withNetworkHint(policy.detail, resolveCodexUpstreamBaseUrl(options, account));
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
    pushMetricError(state.metrics, routeKey, 'codex', 'no_available_account');
    const unavailable = buildNoAvailableAccountResponse('codex', pool, { model: resolvedModel });
    writeJson(res, unavailable.statusCode, unavailable.payload);
    return;
  }
  if (
    orchestration.kind === 'attempts_exhausted'
    && (
      hasUnavailableReason(pool, 'auth_invalid_reauth_required')
      || hasUnavailableReason(pool, 'stream_disconnected_before_completion')
    )
  ) {
    state.metrics.totalFailures += 1;
    pushMetricError(state.metrics, routeKey, 'codex', 'no_available_account');
    const unavailable = buildNoAvailableAccountResponse('codex', pool, { model: resolvedModel });
    if (options.logRequests) {
      appendProxyRequestLog({
        at: new Date().toISOString(),
        requestId: requestMeta && requestMeta.requestId,
        route: routeKey,
        provider: 'codex',
        status: unavailable.statusCode,
        error: lastError || 'no_available_account',
        durationMs: Date.now() - requestStartedAt
      });
    }
    writeJson(res, unavailable.statusCode, unavailable.payload);
    return;
  }

  state.metrics.totalFailures += 1;
  pushMetricError(state.metrics, routeKey, 'codex', {
    message: lastError,
    error: lastError || 'upstream_failed',
    attemptedAccountIds: Array.from(orchestration.attemptedIds || [])
  });
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
    parseCodexModels,
    parseCodexModelsResponse,
    fetchCodexModelsForAccount,
    resolveCodexUpstreamBaseUrl,
    resolveCodexClientVersion,
    resolveCodexModel,
    convertOpenAIChatToCodexPayload,
    convertOpenAIResponsesToCodexPayload,
    convertCodexSseToOpenAIChunks,
    convertCodexResponseToOpenAICompletion,
    extractCodexFailureDetail,
    parseSseEvents
  }
};
