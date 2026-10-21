'use strict';

const fs = require('node:fs');
const { readAccountNativeAuth } = require('./account-credential-store');
const {
  readResponseText,
  sanitizeResponseText
} = require('./response-body');

// ============================================================================
// 官方 OpenCode 网关与认证规范说明 (Official OpenCode Architecture & Auth Spec)
// ----------------------------------------------------------------------------
// 1. 认证机制：
//    - 官方密钥中心：https://opencode.ai/auth 统一创建与管理 API Key。
//    - 环境变量：OPENCODE_API_KEY，可选 OPENCODE_BASE_URL。
// 2. 官方 API 端点：
//    - OpenCode Go 端点：https://opencode.ai/zen/go/v1（默认接口，支持 Go / Zen 全系列模型）
//    - OpenCode Zen 端点：https://opencode.ai/zen/v1
// 3. CLI 原生凭据结构（~/.local/share/opencode/auth.json）：
//    {
//      "opencode": { "type": "api", "key": "<apiKey>" },
//      "opencode-go": { "type": "api", "key": "<apiKey>" }
//    }
// 4. 模型路由与前缀：
//    - 支持前缀：opencode-go/*, opencode/*, zen/*, go/* 以及无前缀直传。
// 5. 免费模型的 429（FreeUsageLimitError）语义 —— 2026-08-18 实测结论，排障必读：
//    - 该限流按「出口 IP × 模型」计，**与 API Key / 账号 / workspace 无关**。
//      证据：同一分钟，本机出口对 deepseek-v4-flash-free / big-pickle / mimo-v2.5-free
//      全部 429（带 key 与匿名一致），而 nemotron-3-ultra-free 同时 200；
//      换到另一出口后，上述模型连匿名请求都是 200。
//    - 因此「换个新账号就有新额度」不成立，新注册的 workspace 一样 429；
//      同理，看到 429 不要去怀疑凭据注入，先确认是不是免费模型 + 当前出口。
//    - 需要换出口时：网关侧设 AIH_SERVER_PROXY_URL（args.js 会读，经 upstream-endpoints
//      透传成本模块的 proxyUrl）；原生 CLI 侧设 HTTP(S)_PROXY —— 注意 opencode 是 Bun
//      运行时，只认 HTTP 代理，socks5 会直接报 UnsupportedProxyProtocol。
//    - 判断 key 本身是否有效：拿它打一个付费模型，返回 CreditsError 且 message 里带
//      workspace id（wrk_…）即为有效；返回 AuthError: Missing API key 才是没凭据。
//      这个 workspace id 每把 key 各不相同，是端到端确认「用的是哪个账号」的最强判据。
// 6. 免费模型的**客户端门禁** —— 2026-10-15 实测结论，推翻了「免费模型不管认证」：
//    - 本模块（HTTP 通道）拿不到免费模型：匿名、伪造 key、**账号真 key**，甚至逐字节
//      复刻 opencode CLI 的请求头 + UA（opencode/1.19.0 ai-sdk/... runtime/bun/...、
//      x-opencode-client/project/request/session/session-id）、HTTP/1.1、带 tools 数组，
//      一律 403 {"type":"FreeTierError","message":"OpenCode's free tier can only be used
//      from within OpenCode"}；curl / node(undici) / Bun fetch 都一样。
//    - 只有真实 opencode 二进制能过（实测 200 + 正常回复），且**必须带有效账号 key**
//      （无 key 的 CLI 同样 403）。另有请求形状约束：把 CLI 的工具全关（tools 全 false）
//      后连 CLI 也吃 403；保留任意只读工具即恢复。
//    - 因此 `-free` 模型改由 lib/server/opencode-free-cli-transport.js 桥接（`opencode run
//      --format json` 原生 CLI → OpenAI chat 语义），本模块只服务付费模型。
//    - 该 403 不是凭据失效：upstream-failure-policy 已单列（opencode_free_tier_client_gated，
//      不锁账号、不冷却、不换号重试）。以前它会落进通用 403 分支把账号锁 1 年。
// ============================================================================

const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
const OPENCODE_GO_MODEL_PREFIX = 'opencode-go/';
const OPENCODE_ZEN_MODEL_PREFIX = 'opencode/';

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

function resolveOpenCodeSessionId(options) {
  const sessionId = String(options && options.opencodeSessionId || '').trim();
  if (!sessionId || /[\r\n\0]/.test(sessionId)) return '';
  return sessionId;
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
  const sessionId = resolveOpenCodeSessionId(options);
  if (sessionId) headers['x-opencode-session'] = sessionId;
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
  const lower = text.toLowerCase();
  if (lower.startsWith('opencode-go/')) {
    return text.slice('opencode-go/'.length);
  }
  if (lower.startsWith('opencode/')) {
    return text.slice('opencode/'.length);
  }
  if (lower.startsWith('zen/')) {
    return text.slice('zen/'.length);
  }
  if (lower.startsWith('go/')) {
    return text.slice('go/'.length);
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
  const baseUrl = normalizeBaseUrl(
    options && (options.opencodeGoBaseUrl || options.openCodeGoBaseUrl || options.baseUrl || options.openaiBaseUrl)
    || account && (account.baseUrl || account.openaiBaseUrl)
  );
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

// 官方目录是**两条腿的并集**：Go（订阅模型）与 Zen（全量含免费档）。两条腿各走一次
// 请求、共用一个超时预算，任何一条腿慢/挂都只会让它的模型消失，另一条腿照常返回。
//
// 2026-10-21 真机事故（本函数此前把这一点吞掉了）：后台刷新的 2.5s 预算下 Zen 腿
// 偶发超时 → 目录只剩 37 个 Go 模型 → 这个**残缺目录**被下游当成「已知且完整的目录」，
// 于是 `opencode/<x>-free` 被判成「该账号不支持」→ 唯一账号被踢出候选池 → 免费模型
// 请求恒定 503 no_available_account。残缺目录绝不能升级成否定证据（同
// model-pool-narrowing 的「目录未知 ≠ 不能服务」），所以这里必须把「不全」如实报出去：
// `incomplete` 由调用方一路上行到排除判定，缺腿的账号在补齐之前不参与否定排除。
function summarizeLegError(result) {
  if (!result || result.status !== 'rejected') return '';
  const reason = result.reason;
  const message = String((reason && (reason.message || reason.code)) || reason || 'probe_failed');
  const status = Number(reason && reason.statusCode);
  return status ? `HTTP_${status}:${message}` : message;
}

/**
 * 探测官方目录，返回模型与「是否残缺」。
 *
 * @returns {Promise<{models: string[], incomplete: boolean, legErrors: object}>}
 *   incomplete=true 表示至少一条腿失败：models 只含成功腿的模型，
 *   调用方**不得**用它否定该账号能服务缺失的那部分模型。
 */
async function probeOpenCodeCatalog(options, account, timeoutMs = 8000, deps = {}) {
  const baseUrl = options && (options.opencodeGoBaseUrl || options.openCodeGoBaseUrl || options.baseUrl || options.openaiBaseUrl)
    || account && (account.baseUrl || account.openaiBaseUrl);

  // If explicit custom baseUrl provided, probe that endpoint directly
  if (baseUrl && !baseUrl.includes('opencode.ai')) {
    const payload = await fetchOpenCodeGoJson('/models', options || {}, account || {}, timeoutMs, deps);
    const models = Array.from(new Set(listModelsFromOpenAIList(payload))).sort();
    return { models, incomplete: false, legErrors: {} };
  }

  // Official OpenCode: probe both Go (subscription models) and Zen (full catalog + free tier)
  const [goResult, zenResult] = await Promise.allSettled([
    fetchOpenCodeGoJson('/models', { ...options, opencodeGoBaseUrl: OPENCODE_GO_BASE_URL }, account || {}, timeoutMs, deps),
    fetchOpenCodeGoJson('/models', { ...options, opencodeGoBaseUrl: OPENCODE_ZEN_BASE_URL }, account || {}, timeoutMs, deps)
  ]);

  const goPayload = goResult.status === 'fulfilled' ? goResult.value : null;
  const zenPayload = zenResult.status === 'fulfilled' ? zenResult.value : null;
  const legErrors = {};
  const goError = summarizeLegError(goResult);
  const zenError = summarizeLegError(zenResult);
  if (goError) legErrors.go = goError;
  if (zenError) legErrors.zen = zenError;

  if (!goPayload && !zenPayload) {
    const primaryError = (goResult.status === 'rejected' && goResult.reason)
      || (zenResult.status === 'rejected' && zenResult.reason);
    if (primaryError) throw primaryError;
  }

  const models = new Set();
  (Array.isArray(goPayload && goPayload.data) ? goPayload.data : []).forEach((m) => {
    const id = stripOpenCodeGoModelPrefix(m && (m.id || m.model));
    if (id) models.add(`${OPENCODE_GO_MODEL_PREFIX}${id}`);
  });

  (Array.isArray(zenPayload && zenPayload.data) ? zenPayload.data : []).forEach((m) => {
    const id = stripOpenCodeGoModelPrefix(m && (m.id || m.model));
    if (id) models.add(`${OPENCODE_ZEN_MODEL_PREFIX}${id}`);
  });

  return { models: Array.from(models).sort(), incomplete: Object.keys(legErrors).length > 0, legErrors };
}

async function fetchOpenCodeModels(options, account, timeoutMs = 8000, deps = {}) {
  const { models } = await probeOpenCodeCatalog(options, account, timeoutMs, deps);
  return models;
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

function resolveOpenCodeBaseUrl(model, options = {}, account = {}) {
  const explicit = options.opencodeGoBaseUrl || options.openCodeGoBaseUrl || options.baseUrl || options.openaiBaseUrl
    || account.baseUrl || account.openaiBaseUrl;
  if (explicit) return normalizeBaseUrl(explicit);

  const lower = String(model || '').trim().toLowerCase();
  if (lower.startsWith('opencode/') || lower.startsWith('zen/')) {
    return OPENCODE_ZEN_BASE_URL;
  }
  return OPENCODE_GO_BASE_URL;
}

async function fetchOpenCodeChatCompletion(options, account, requestJson = {}, timeoutMs = 8000, deps = {}) {
  ensureOpenCodeGoApiKey(options || {}, account || {}, deps);
  const requestedModel = String(requestJson && requestJson.model || '').trim();
  const upstreamModel = stripOpenCodeGoModelPrefix(requestedModel);
  if (!upstreamModel) throw new Error('opencode_go_model_required');

  const effectiveBaseUrl = resolveOpenCodeBaseUrl(requestedModel, options, account);
  const requestOptions = { ...options, opencodeGoBaseUrl: effectiveBaseUrl };

  if (isAnthropicMessagesModel(upstreamModel)) {
    const payload = await fetchOpenCodeGoJson('/messages', requestOptions, account || {}, timeoutMs, deps, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildAnthropicMessagesPayload(requestJson, upstreamModel))
    });
    return toOpenAIFromAnthropicMessage(payload, requestedModel, requestJson);
  }

  const payload = await fetchOpenCodeGoJson('/chat/completions', requestOptions, account || {}, timeoutMs, deps, {
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

  const effectiveBaseUrl = resolveOpenCodeBaseUrl(requestedModel, options, account);
  const requestOptions = { ...options, opencodeGoBaseUrl: effectiveBaseUrl };

  const res = await fetchOpenCodeGoResponse('/chat/completions', requestOptions, account || {}, timeoutMs, deps, {
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
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_GO_MODEL_PREFIX,
  fetchOpenCodeChatCompletion,
  fetchOpenCodeChatCompletionStream,
  fetchOpenCodeModels,
  probeOpenCodeCatalog,
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
    probeOpenCodeCatalog,
    summarizeLegError,
    readOpenCodeGoApiKeyFromAuth,
    resolveOpenCodeGoApiKey,
    resolveOpenCodeSessionId,
    readOpenCodeRequestSessionId,
    stripOpenCodeGoModelPrefix,
    toOpenAIFromAnthropicMessage,
    normalizeOpenAIChatPayload
  }
};
