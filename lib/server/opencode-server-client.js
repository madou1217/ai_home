'use strict';

const fs = require('node:fs');
const { readAccountNativeAuth } = require('./account-credential-store');
const {
  readResponseText,
  sanitizeResponseText
} = require('./response-body');

const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
const OPENCODE_GO_MODEL_PREFIX = 'opencode-go/';

const ANTHROPIC_MESSAGES_MODELS = new Set([
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus'
]);

function normalizeBaseUrl(value) {
  return String(value || OPENCODE_GO_BASE_URL).trim().replace(/\/+$/, '');
}

function toPlainText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function sanitizeApiKey(value) {
  const key = String(value || '').trim();
  if (!key || /[\r\n\0]/.test(key)) return '';
  return key;
}

function createHttpError(status, text) {
  const error = new Error(`HTTP ${status} ${sanitizeResponseText(text)}`.trim());
  error.code = `HTTP_${status}`;
  error.statusCode = status;
  error.responseBody = String(text || '');
  return error;
}

function readOpenCodeGoApiKeyFromAuth(auth) {
  const providers = auth && typeof auth === 'object' && !Array.isArray(auth) ? auth : {};
  return sanitizeApiKey(
    providers['opencode-go'] && providers['opencode-go'].key
    || providers.opencode && providers.opencode.key
    || ''
  );
}

function resolveOpenCodeGoApiKey(options, account, deps = {}) {
  const explicit = sanitizeApiKey(
    options && (options.opencodeGoApiKey || options.openCodeGoApiKey)
    || account && (account.opencodeGoApiKey || account.openCodeGoApiKey)
    || ''
  );
  if (explicit) return explicit;

  const accessToken = sanitizeApiKey(account && account.accessToken);
  if (accessToken && accessToken !== 'opencode-local') return accessToken;

  const accountRef = String(account && account.accountRef || '').trim();
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const auth = account && account.opencodeAuth
    ? account.opencodeAuth
    : accountRef && aiHomeDir
      ? readAccountNativeAuth(deps.fs || fs, aiHomeDir, accountRef).auth
      : null;
  return readOpenCodeGoApiKeyFromAuth(auth);
}

function buildOpenCodeGoHeaders(options, account, deps = {}, extra = {}) {
  const headers = {
    accept: 'application/json',
    ...extra
  };
  const apiKey = resolveOpenCodeGoApiKey(options, account, deps);
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function ensureOpenCodeGoApiKey(options, account, deps = {}) {
  const apiKey = resolveOpenCodeGoApiKey(options, account, deps);
  if (!apiKey) {
    const error = new Error('invalid_opencode_go_api_key');
    error.code = 'invalid_opencode_go_api_key';
    throw error;
  }
  return apiKey;
}

function stripOpenCodeGoModelPrefix(model) {
  const text = String(model || '').trim();
  if (text.toLowerCase().startsWith(OPENCODE_GO_MODEL_PREFIX)) {
    return text.slice(OPENCODE_GO_MODEL_PREFIX.length);
  }
  return text;
}

function prefixOpenCodeGoModel(model) {
  const id = stripOpenCodeGoModelPrefix(model).trim();
  return id ? `${OPENCODE_GO_MODEL_PREFIX}${id}` : '';
}

function isAnthropicMessagesModel(model) {
  const id = stripOpenCodeGoModelPrefix(model).toLowerCase();
  return ANTHROPIC_MESSAGES_MODELS.has(id)
    || id.startsWith('qwen3.')
    || /^minimax-m[23](\.|-|$)/.test(id);
}

function resolveModelPair(model) {
  return {
    providerID: 'opencode-go',
    modelID: stripOpenCodeGoModelPrefix(model || '').trim()
  };
}

function toText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return String(part.text || '');
      if (part.type === 'input_text') return String(part.text || '');
      return '';
    }).filter(Boolean).join('\n');
  }
  if (value == null) return '';
  return String(value);
}

function buildOpenCodePrompt(requestJson = {}) {
  const system = [];
  const lines = [];
  (Array.isArray(requestJson.messages) ? requestJson.messages : []).forEach((message) => {
    if (!message || typeof message !== 'object') return;
    const role = String(message.role || '').trim().toLowerCase();
    const content = toText(message.content).trim();
    if (!content) return;
    if (role === 'system' || role === 'developer') {
      system.push(content);
      return;
    }
    if (role === 'assistant') {
      lines.push(`Assistant: ${content}`);
      return;
    }
    if (role === 'tool') {
      lines.push(`Tool: ${content}`);
      return;
    }
    lines.push(`User: ${content}`);
  });
  const fallback = String(requestJson.prompt || requestJson.input || '').trim();
  return {
    system: system.join('\n\n'),
    text: lines.length > 0 ? lines.join('\n\n') : fallback
  };
}

function buildOpenAIChatPayload(requestJson, upstreamModel, options = {}) {
  const {
    session_id: _sessionIdSnake,
    sessionId: _sessionIdCamel,
    conversation_id: _conversationId,
    provider: _provider,
    accountRef: _accountRef,
    gateway: _gateway,
    account: _account,
    metadata: _metadata,
    ...safeRequest
  } = requestJson || {};
  return {
    ...safeRequest,
    model: upstreamModel,
    stream: Boolean(options.stream)
  };
}

function buildAnthropicMessagesPayload(requestJson, upstreamModel) {
  const messages = [];
  const system = [];
  (Array.isArray(requestJson && requestJson.messages) ? requestJson.messages : []).forEach((message) => {
    if (!message || typeof message !== 'object') return;
    const role = String(message.role || '').trim().toLowerCase();
    const content = toText(message.content).trim();
    if (!content) return;
    if (role === 'system' || role === 'developer') {
      system.push(content);
      return;
    }
    messages.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content
    });
  });
  const prompt = buildOpenCodePrompt(requestJson || {});
  if (messages.length < 1 && prompt.text) messages.push({ role: 'user', content: prompt.text });

  const payload = {
    model: upstreamModel,
    max_tokens: Math.max(1, Number(requestJson && (requestJson.max_tokens || requestJson.maxTokens)) || 4096),
    messages
  };
  if (system.length > 0 || prompt.system) {
    payload.system = system.join('\n\n') || prompt.system;
  }
  const temperature = Number(requestJson && requestJson.temperature);
  if (Number.isFinite(temperature)) payload.temperature = temperature;
  return payload;
}

async function readJsonResponse(res) {
  const text = await readResponseText(res);
  if (!res.ok) throw createHttpError(res.status, text);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    error.message = `invalid_json_response: ${error.message}`;
    error.statusCode = res.status;
    error.responseBody = text;
    throw error;
  }
}

async function fetchOpenCodeGoJson(pathname, options, account, timeoutMs, deps = {}, init = {}) {
  const res = await fetchOpenCodeGoResponse(pathname, options, account, timeoutMs, deps, init);
  return readJsonResponse(res);
}

async function fetchOpenCodeGoResponse(pathname, options, account, timeoutMs, deps = {}, init = {}) {
  const fetchWithTimeout = deps.fetchWithTimeout || fetch;
  const baseUrl = normalizeBaseUrl(options && (options.opencodeGoBaseUrl || options.openCodeGoBaseUrl));
  const url = `${baseUrl}${pathname}`;
  return await fetchWithTimeout(url, {
    method: init.method || 'GET',
    headers: buildOpenCodeGoHeaders(options, account, deps, init.headers),
    ...(Object.prototype.hasOwnProperty.call(init, 'body') ? { body: init.body } : {})
  }, Math.max(1, Number(timeoutMs) || 8000), {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
}

function listModelsFromOpenAIList(payload) {
  return (Array.isArray(payload && payload.data) ? payload.data : [])
    .map((model) => prefixOpenCodeGoModel(model && (model.id || model.model)))
    .filter(Boolean);
}

async function fetchOpenCodeModels(options, account, timeoutMs = 8000, deps = {}) {
  const payload = await fetchOpenCodeGoJson('/models', options || {}, account || {}, timeoutMs, deps);
  return Array.from(new Set(listModelsFromOpenAIList(payload))).sort();
}

function readOpenCodeRequestSessionId(requestJson) {
  return String(requestJson && requestJson.session_id || '').trim();
}

function removeOpenCodeUpstreamSessionFields(body) {
  delete body.session_id;
  delete body.sessionId;
  delete body.conversation_id;
}

function normalizeOpenAIChatPayload(payload, requestedModel, requestJson) {
  const body = payload && typeof payload === 'object' ? { ...payload } : {};
  removeOpenCodeUpstreamSessionFields(body);
  body.id = String(body.id || `chatcmpl-${Date.now()}`);
  body.object = String(body.object || 'chat.completion');
  body.created = Number(body.created || Math.floor(Date.now() / 1000));
  body.model = prefixOpenCodeGoModel(requestedModel || body.model);
  if (!Array.isArray(body.choices)) {
    body.choices = [{
      index: 0,
      message: { role: 'assistant', content: '' },
      finish_reason: 'stop'
    }];
  }
  if (!body.usage || typeof body.usage !== 'object') {
    body.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  }
  const sessionId = readOpenCodeRequestSessionId(requestJson);
  if (sessionId) {
    body.session_id = sessionId;
    body.sessionId = sessionId;
  }
  return body;
}

function readAnthropicText(payload) {
  return (Array.isArray(payload && payload.content) ? payload.content : [])
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return String(part.text || '');
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function toOpenAIFromAnthropicMessage(payload, requestedModel, requestJson) {
  const usage = payload && payload.usage && typeof payload.usage === 'object' ? payload.usage : {};
  const promptTokens = Number(usage.input_tokens || 0);
  const completionTokens = Number(usage.output_tokens || 0);
  const sessionId = readOpenCodeRequestSessionId(requestJson);
  const out = {
    id: String(payload && payload.id || `chatcmpl-${Date.now()}`),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: prefixOpenCodeGoModel(requestedModel),
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: readAnthropicText(payload)
      },
      finish_reason: String(payload && payload.stop_reason || 'stop')
    }],
    usage: {
      prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : 0,
      completion_tokens: Number.isFinite(completionTokens) ? completionTokens : 0,
      total_tokens: Number.isFinite(promptTokens + completionTokens) ? promptTokens + completionTokens : 0
    }
  };
  if (sessionId) {
    out.session_id = sessionId;
    out.sessionId = sessionId;
  }
  return out;
}

async function fetchOpenCodeChatCompletion(options, account, requestJson = {}, timeoutMs = 8000, deps = {}) {
  ensureOpenCodeGoApiKey(options || {}, account || {}, deps);
  const requestedModel = String(requestJson && requestJson.model || '').trim();
  const upstreamModel = stripOpenCodeGoModelPrefix(requestedModel);
  if (!upstreamModel) throw new Error('opencode_go_model_required');

  if (isAnthropicMessagesModel(upstreamModel)) {
    const payload = await fetchOpenCodeGoJson('/messages', options || {}, account || {}, timeoutMs, deps, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildAnthropicMessagesPayload(requestJson, upstreamModel))
    });
    return toOpenAIFromAnthropicMessage(payload, requestedModel, requestJson);
  }

  const payload = await fetchOpenCodeGoJson('/chat/completions', options || {}, account || {}, timeoutMs, deps, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildOpenAIChatPayload(requestJson, upstreamModel))
  });
  return normalizeOpenAIChatPayload(payload, requestedModel, requestJson);
}

async function fetchOpenCodeChatCompletionStream(options, account, requestJson = {}, timeoutMs = 8000, deps = {}) {
  ensureOpenCodeGoApiKey(options || {}, account || {}, deps);
  const requestedModel = String(requestJson && requestJson.model || '').trim();
  const upstreamModel = stripOpenCodeGoModelPrefix(requestedModel);
  if (!upstreamModel) throw new Error('opencode_go_model_required');
  if (isAnthropicMessagesModel(upstreamModel)) {
    const error = new Error('opencode_go_stream_unsupported_for_anthropic_messages_model');
    error.code = 'OPENCODE_STREAM_UNSUPPORTED';
    throw error;
  }

  const res = await fetchOpenCodeGoResponse('/chat/completions', options || {}, account || {}, timeoutMs, deps, {
    method: 'POST',
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json'
    },
    body: JSON.stringify(buildOpenAIChatPayload(requestJson, upstreamModel, { stream: true }))
  });
  if (!res.ok) {
    const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
    throw createHttpError(res.status, text);
  }
  return res;
}

module.exports = {
  OPENCODE_GO_BASE_URL,
  OPENCODE_GO_MODEL_PREFIX,
  fetchOpenCodeChatCompletion,
  fetchOpenCodeChatCompletionStream,
  fetchOpenCodeModels,
  resolveModelPair,
  buildOpenCodePrompt,
  __private: {
    buildAnthropicMessagesPayload,
    buildOpenAIChatPayload,
    buildOpenCodeGoHeaders,
    createHttpError,
    fetchOpenCodeGoJson,
    isAnthropicMessagesModel,
    listModelsFromOpenAIList,
    prefixOpenCodeGoModel,
    readOpenCodeGoApiKeyFromAuth,
    resolveOpenCodeGoApiKey,
    readOpenCodeRequestSessionId,
    stripOpenCodeGoModelPrefix,
    toOpenAIFromAnthropicMessage,
    normalizeOpenAIChatPayload
  }
};
