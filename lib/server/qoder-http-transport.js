'use strict';

// Qoder / Qoder CN 的 **HTTP 直连**推理 transport。
//
// 事实来源（2026-10-20 真机取证，见 docs/providers/qoder-client-protocol.md）：
//   * 官方客户端把请求体明文 JSON 交给内嵌 WASM 的 `prepareInferRequest`：
//     返回改写后的 url（含 Encode=1）、20 个签名头与一个自定义编码串（不是明文 JSON）；
//     客户端再用 zstd(level 1) 压缩该串，附 `Content-Encoding: zstd` 发出。
//   * 上游是 SSE：外层 `data:{"headers":...,"body":"<OpenAI chunk JSON>","statusCodeValue":200...}`，
//     内层是标准 OpenAI chat.completion.chunk；结束前有真实 usage（prompt/completion/
//     cached/reasoning/credits）与 timing 帧。
//   * 最小合法 body 已实测：system + 单条 user、tools:[]、business/model_config 形状正确、
//     无 flow 字段时不会触发 `agent_router msg:None flow nodes found`。
//
// 本模块的职责边界：
//   - 只做「协议复刻 + 传输」：不解释账号状态、不记账、不写响应（Strategy 负责）；
//   - 签名器可注入（测试用假签名器，不依赖 wasm）；wasm 不可用 / 认证缺失 / HTTP 失败
//     一律抛出带 code 的错误，由 Strategy 决定是否回落到 CLI；
//   - 首字节之前失败可回落，首字节之后失败绝不伪装成成功（流会被 destroy）。
//
// 安全：凭据明文、machineToken、签名串都不落盘、不写日志；日志只允许出现 endpoint /
// 状态码 / usage 数值。

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const zlib = require('node:zlib');
const { createSseBodyStream } = require('./sse-body-stream');

const {
  resolveProxyConfig,
  getProxyDispatcher,
  shouldRetryWithoutProxy
} = require('./http-utils-utils');
const { createNativeRunWatchdog } = require('./native-run-watchdog');
const { createQoderAuthRuntime } = require('../account/qoder-auth-wasm');
const {
  readQoderAuthWasm,
  instantiateQoderAuthWasm
} = require('../account/qoder-credential-decrypt').__private;
const {
  supportsQoderCliTransport,
  __private: { buildQoderCliInvocation, extractMessageText }
} = require('./qoder-cli-transport');
const {
  readQoderTokenCounters,
  resolveQoderUsage,
  toOpenAiUsage
} = require('../usage/qoder-usage');
const { normalizePathString } = require('../runtime/platform-path');
const { resolveQoderClientLayout } = require('../runtime/qoder-client-layouts');
const {
  readQoderModelCatalog,
  resolveQoderCatalogModel,
  deriveQoderModelRequest,
  buildQoderModelConfig
} = require('../account/qoder-model-catalog');
const { resolveQoderHttpEndpoint } = require('../account/qoder-endpoint');

const QODER_HTTP_TRANSPORT_ID = 'qoder_http_sse';
// 与 CLI 通道同一套实测预算：首包 / 静默 120s，单轮硬上限 30min。
const MIN_HTTP_IDLE_TIMEOUT_MS = 120000;
const DEFAULT_HTTP_MAX_TURN_MS = 30 * 60 * 1000;
// 代理探测预算：qoder/qodercn 实测首包 0.8s / 3.5s。代理若把国内站黑洞掉，
// 15s 足够判定「代理不可用」，再回落直连；健康代理不会被误杀。
const PROXY_FIRST_EVENT_TIMEOUT_MS = 15000;
const DEFAULT_SYSTEM_TEXT = 'You are a helpful assistant.';
const MAX_SIGNER_CACHE = 4;
const MAX_ERROR_BODY_CHARS = 2000;

const signerCache = new Map();

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function supportsQoderHttpTransport(provider) {
  return supportsQoderCliTransport(provider);
}

function qoderLayout(provider, version) {
  return resolveQoderClientLayout({ provider, version: version || '' });
}

function qoderClientDir(provider, version) {
  const layout = qoderLayout(provider, version);
  return layout && typeof layout.homeDir === 'string' ? layout.homeDir : '';
}

function qoderSessionType(provider, version) {
  const layout = qoderLayout(provider, version);
  return layout && layout.inference && typeof layout.inference.sessionType === 'string'
    ? layout.inference.sessionType
    : '';
}

function qoderHttpError(code, message, extra) {
  const error = new Error(message || code);
  error.code = code;
  if (extra && typeof extra === 'object') Object.assign(error, extra);
  return error;
}

/** 解析 qoder 全球站的服务端资源限流负载（见 qoderQueueInfo 上游注释）：{"code":"10605",...,"isQueued":true,...,"retryAfterSeconds":30,...} */
function qoderQueueInfo(detail) {
  const text = normalizeString(detail);
  if (!text) return null;
  // 限流负载可能被套了多层 JSON 字符串（实测三层：外层 code/message →
  // 中间 code 10605/message → 真正的 isQueued/retryAfterSeconds）。
  let inner = text;
  let current = null;
  try { current = JSON.parse(text); } catch (_error) { current = null; }
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    inner += `\n${JSON.stringify(current)}`;
    if (typeof current.message !== 'string') break;
    try { current = JSON.parse(current.message); } catch (_error) { break; }
  }
  const lower = inner.toLowerCase();
  if (
    !lower.includes('10605') &&
    !lower.includes('resource_limit') &&
    !/"isqueued"\s*:\s*true/.test(lower)
  ) {
    return null;
  }
  const retry = inner.match(/"retryAfterSeconds"\s*:\s*(\d+)/);
  const wait = inner.match(/"waitTime"\s*:\s*(\d+)/);
  const qt = inner.match(/"queueType"\s*:\s*"([^"]+)"/);
  return {
    retryAfterSeconds: retry ? Number(retry[1]) : undefined,
    queueType: qt ? qt[1] : undefined,
    waitTime: wait ? Number(wait[1]) : undefined
  };
}

function createRequestId() {
  return crypto.randomUUID();
}

function readJsonFile(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function readFileText(fs, filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_error) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 纯函数：请求体（可单测，不依赖 wasm / 网络）
// ---------------------------------------------------------------------------

function collectSystemText(messages) {
  const parts = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || '').toLowerCase();
    if (role !== 'system' && role !== 'developer') continue;
    const text = normalizeString(extractMessageText(message.content));
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

function findLastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || String(message.role || '').toLowerCase() !== 'user') continue;
    const text = normalizeString(extractMessageText(message.content));
    if (text) return text;
  }
  return '';
}

function describeQoderToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return '';
  const parts = [];
  for (const call of toolCalls) {
    if (!call || typeof call !== 'object') continue;
    const fn = call.function && typeof call.function === 'object' ? call.function : call;
    const name = normalizeString(fn.name || call.name);
    if (!name) continue;
    const args = typeof fn.arguments === 'string'
      ? fn.arguments
      : (fn.arguments === undefined ? '' : JSON.stringify(fn.arguments));
    parts.push(`[调用工具 ${name}]${args ? `\n${args}` : ''}`);
  }
  return parts.join('\n');
}

// 把结构化对话压成一条 user transcript：与真实客户端 body 的「system + 单条 user」同形。
// 单条 user 请求原样返回正文（真机抓包就是这样）；多轮才加角色标签，避免模型把多个
// User: 块当成背景。tools 仍走 body.tools，由模型发起新的工具调用。
function buildQoderHttpTranscript(messages) {
  const conversational = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || '').toLowerCase();
    if (role === 'system' || role === 'developer') continue;
    if (!['user', 'assistant', 'tool'].includes(role)) continue;
    conversational.push({ role, message });
  }
  if (conversational.length === 0) return '';
  if (conversational.length === 1 && conversational[0].role === 'user') {
    return normalizeString(extractMessageText(conversational[0].message.content));
  }
  const blocks = [];
  for (const { role, message } of conversational) {
    const text = normalizeString(extractMessageText(message.content));
    const label = role === 'user' ? 'User' : (role === 'assistant' ? 'Assistant' : 'Tool');
    const extra = role === 'assistant' ? describeQoderToolCalls(message.tool_calls) : '';
    const body = [text, extra].filter(Boolean).join('\n');
    if (body) blocks.push(`${label}:\n${body}`);
  }
  return blocks.join('\n\n');
}

function normalizeQoderToolParameters(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (!value.type) return { ...value, type: 'object' };
    return value;
  }
  return { type: 'object', properties: {} };
}

function normalizeQoderHttpTools(tools) {
  if (!Array.isArray(tools)) return [];
  const normalized = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.type && tool.type !== 'function') continue;
    const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool;
    const name = normalizeString(fn.name || tool.name);
    if (!name || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) continue;
    const description = normalizeString(fn.description || tool.description) || name;
    const parameters = normalizeQoderToolParameters(
      fn.parameters || fn.input_schema || tool.parameters || tool.input_schema
    );
    normalized.push({ type: 'function', function: { name, description, parameters } });
  }
  return normalized;
}

function readRequestInteger(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  }
  return 0;
}

/**
 * 解析请求模型名 → 目录条目 + 请求级派生字段。
 *
 * 事实来源是**服务端目录**（catalog-v7），不是模型名：
 *   * `model_config.key` 必须是目录 key（例如 `Qwen3.8-Flash` 对应 `qfmodel`）；
 *   * `is_reasoning` / `is_vl` / `max_input_tokens` 全部按目录条目取；
 *   * 请求级只做 true → false 的降级（reasoning_effort=none / enable_thinking=false /
 *     thinkingBudget=0），与官方客户端 `Dvt()` 一致。
 *
 * 目录不可用且请求的不是 Auto 时**直接抛错**（fail-closed），由 Strategy 回落 CLI：
 * 用名字猜 key / reasoning 会把真实模型请求静默降级成 Auto，这是必须避免的。
 */
function normalizeQoderHttpModelInfo(requestJson, requestMeta, provider, catalog) {
  const alias = requestMeta && requestMeta.aliasResolution && requestMeta.aliasResolution.effectiveModel;
  const raw = normalizeString(alias || (requestJson && requestJson.model));
  const resolved = resolveQoderCatalogModel(catalog, raw, provider);
  if (!resolved.entry) {
    throw qoderHttpError(
      'qoder_http_model_catalog_missing',
      'qoder_http_model_catalog_missing',
      {
        requestedModel: raw,
        catalogReason: normalizeString(catalog && catalog.reason) || 'model_catalog_unavailable'
      }
    );
  }
  const derived = deriveQoderModelRequest(resolved.entry, requestJson);
  return {
    modelKey: resolved.entry.key,
    displayName: resolved.entry.displayName,
    isReasoning: derived.isReasoning,
    // 请求级显式值只用于参数透传，不反过来猜模型能力。
    reasoningEffort: derived.reasoningEffort,
    enableThinking: derived.enableThinking,
    thinkingDisabled: derived.disabled === true,
    modelSource: resolved.source,
    modelConfig: buildQoderModelConfig(resolved.entry, derived),
    requestedModel: raw
  };
}

function buildQoderHttpParameters(requestJson, modelInfo) {
  const maxTokens = readRequestInteger(
    requestJson && requestJson.max_tokens,
    requestJson && requestJson.max_completion_tokens,
    requestJson && requestJson.max_output_tokens
  );
  const parameters = { max_tokens: Math.min(32000, maxTokens || 32000) };
  const temperature = Number(requestJson && requestJson.temperature);
  if (Number.isFinite(temperature) && temperature >= 0) parameters.temperature = temperature;
  const topP = Number(requestJson && requestJson.top_p);
  if (Number.isFinite(topP) && topP >= 0) parameters.top_p = topP;
  const stop = requestJson && requestJson.stop;
  if (typeof stop === 'string' && stop) parameters.stop = stop;
  if (Array.isArray(stop) && stop.length > 0) {
    parameters.stop = stop.map((item) => String(item)).filter(Boolean);
  }
  // 推理参数只透传**调用方显式给的值**，不按模型目录猜默认 effort：
  //   * 显式 effort（除 none）原样下发；
  //   * 显式关闭（none / enable_thinking=false / thinkingBudget<=0）用
  //     `enable_thinking:false` 表达，和 model_config.is_reasoning=false 同步；
  //   * 调用方没提推理时完全不写这两个字段（保持既有最小 body 行为）。
  if (modelInfo) {
    if (modelInfo.thinkingDisabled === true) {
      parameters.enable_thinking = false;
    } else if (modelInfo.reasoningEffort) {
      parameters.reasoning_effort = modelInfo.reasoningEffort;
    }
    if (modelInfo.enableThinking === true && parameters.enable_thinking === undefined) {
      parameters.enable_thinking = true;
    }
  }
  return parameters;
}

/**
 * 构造 Qoder 推理 body（明文）。
 *
 * @param {object} requestJson 网关 canonical request（OpenAI chat 形状）
 * @param {object} options { provider, version, requestMeta, catalog }
 *   `catalog` 只读（由调用方按账号投影加载）；缺失时非 Auto 请求会被
 *   `normalizeQoderHttpModelInfo` fail-closed 拒绝。
 * @returns {{body:object, modelKey:string, displayName:string, isReasoning:boolean,
 *   modelSource:string, modelEntry:object, transcript:string, systemText:string,
 *   usagePromptText:string, requestId:string, requestSetId:string, sessionId:string,
 *   toolCount:number}}
 */
function buildQoderHttpRequestBody(requestJson = {}, options = {}) {
  const provider = normalizeString(options.provider).toLowerCase();
  const version = normalizeString(options.version);
  const requestMeta = options.requestMeta || {};
  const sessionType = normalizeString(options.sessionType) || qoderSessionType(provider, version);
  const messages = Array.isArray(requestJson.messages) ? requestJson.messages : [];
  const model = normalizeQoderHttpModelInfo(requestJson, requestMeta, provider, options.catalog);
  const systemText = collectSystemText(messages) || DEFAULT_SYSTEM_TEXT;
  const transcript = buildQoderHttpTranscript(messages);
  if (!transcript) {
    throw qoderHttpError('qoder_http_prompt_required', 'qoder_http_prompt_required');
  }
  const lastUserText = findLastUserText(messages) || transcript;
  const tools = normalizeQoderHttpTools(requestJson.tools);
  const parameters = buildQoderHttpParameters(requestJson, model);
  const requestId = createRequestId();
  const requestSetId = createRequestId();
  const sessionId = createRequestId();
  const now = Date.now();
  const systemArray = [{ type: 'text', text: systemText }];
  // model_config 完全由目录条目派生（key / display_name / format / is_vl /
  // is_reasoning / source / max_input_tokens），不再有硬编码的 is_vl:true 与
  // max_input_tokens:200000 —— 同一展示名在两个站点上的取值本来就不一样。
  const modelConfig = model.modelConfig;
  const body = {
    request_id: requestId,
    request_set_id: requestSetId,
    chat_record_id: requestId,
    session_id: sessionId,
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text: transcript,
      features: [],
      extra: {
        context: [],
        modelConfig: { key: model.modelKey, is_reasoning: model.isReasoning },
        originalContent: transcript
      },
      chatPrompt: '',
      imageUrls: null
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: sessionType,
    aliyun_user_type: '',
    model_config: modelConfig,
    system: systemArray,
    messages: [
      { role: 'system', content: systemArray },
      { role: 'user', content: transcript }
    ],
    tools,
    parameters,
    business: {
      product: 'cli',
      version,
      type: 'agent',
      id: requestSetId,
      name: normalizeString(lastUserText).slice(0, 200) || transcript.slice(0, 200),
      begin_at: now,
      stage: 'start',
      model_key: model.modelKey
    }
  };
  return {
    body,
    modelKey: model.modelKey,
    displayName: model.displayName,
    isReasoning: model.isReasoning,
    modelSource: model.modelSource,
    modelConfig,
    transcript,
    systemText,
    usagePromptText: `${systemText}\n\n${transcript}`,
    requestId,
    requestSetId,
    sessionId,
    toolCount: tools.length
  };
}

// ---------------------------------------------------------------------------
// 客户端缓存：版本 / UMID / DNS
// ---------------------------------------------------------------------------
// 端点解析只有一处实现：lib/account/qoder-endpoint.js（模型发现也用同一份）。

function resolveQoderClientVersion(cliPath, provider) {
  const match = String(cliPath || '').match(/(\d+\.\d+\.\d+)/);
  if (match) return match[1];
  // 版本兜底也走布局表：新增/升级客户端时只改布局事实，不在 transport 里再写一份。
  const layout = resolveQoderClientLayout({ provider: normalizeString(provider).toLowerCase() });
  return layout && layout.cliVersion ? String(layout.cliVersion) : '';
}

function readQoderUmid(input = {}) {
  const fs = input.fs || nodeFs;
  const path = input.path || nodePath;
  const provider = normalizeString(input.provider).toLowerCase();
  const clientDir = qoderClientDir(provider, input.version);
  const candidates = [];
  if (input.runtimeDir) candidates.push(path.join(input.runtimeDir, 'umid-cache.json'));
  if (input.hostHomeDir && clientDir) candidates.push(path.join(input.hostHomeDir, clientDir, 'umid-cache.json'));
  for (const filePath of candidates) {
    const cache = readJsonFile(fs, filePath);
    const info = cache && cache.info && typeof cache.info === 'object' ? cache.info : null;
    const machineToken = normalizeString(info && info.machineToken);
    const machineType = normalizeString(info && info.machineType);
    if (machineToken && machineType) return { machineToken, machineType, source: filePath };
  }
  return { machineToken: '', machineType: '', source: '' };
}

function readQoderDnsIps(input = {}) {
  const fs = input.fs || nodeFs;
  const path = input.path || nodePath;
  const provider = normalizeString(input.provider).toLowerCase();
  const hostname = normalizeString(input.hostname);
  if (!hostname) return [];
  const clientDir = qoderClientDir(provider, input.version);
  const candidates = [];
  if (input.runtimeDir) candidates.push(path.join(input.runtimeDir, '.cache', 'dns-cache.json'));
  if (input.hostHomeDir && clientDir) candidates.push(path.join(input.hostHomeDir, clientDir, '.cache', 'dns-cache.json'));
  for (const filePath of candidates) {
    const cache = readJsonFile(fs, filePath);
    const accounts = cache && cache.accounts && typeof cache.accounts === 'object' ? cache.accounts : null;
    if (!accounts) continue;
    for (const entry of Object.values(accounts)) {
      const record = entry && entry[hostname];
      const ips = record && Array.isArray(record.ips) ? record.ips.filter((ip) => typeof ip === 'string' && ip) : [];
      if (ips.length > 0) return ips;
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// WASM 签名器（进程内缓存：二进制 → runtime/decryptor，账号投影 → context）
// ---------------------------------------------------------------------------

function getQoderWasmSigner({ fs, cliPath }) {
  let stat = null;
  try {
    stat = fs.statSync(cliPath);
  } catch (_error) {
    throw qoderHttpError('qoder_http_cli_binary_missing', 'qoder_http_cli_binary_missing', { cliPath });
  }
  const cacheKey = `${cliPath}:${stat.size}:${stat.mtimeMs}`;
  const cached = signerCache.get(cacheKey);
  if (cached) return cached;

  const wasmBytes = readQoderAuthWasm(fs, cliPath);
  if (!wasmBytes || wasmBytes.length === 0) {
    throw qoderHttpError('qoder_http_wasm_unavailable', 'qoder_http_wasm_unavailable');
  }
  const runtime = createQoderAuthRuntime(wasmBytes);
  const decryptor = instantiateQoderAuthWasm(wasmBytes);
  const authCache = new Map();

  const readAuthContext = ({ runtimeDir, version }) => {
    const userPath = nodePath.join(runtimeDir, '.auth', 'user');
    const machinePath = nodePath.join(runtimeDir, '.auth', 'machine_id');
    const blob = normalizeString(readFileText(fs, userPath));
    const machineId = normalizeString(readFileText(fs, machinePath));
    if (!blob || !machineId) {
      throw qoderHttpError('qoder_http_auth_missing', 'qoder_http_auth_missing', { runtimeDir });
    }
    const cachedAuth = authCache.get(runtimeDir);
    if (cachedAuth && cachedAuth.blob === blob && cachedAuth.machineId === machineId) {
      return cachedAuth.context;
    }
    let plaintext = '';
    try {
      plaintext = decryptor.decrypt(blob, machineId.slice(0, 16));
      JSON.parse(plaintext);
    } catch (error) {
      throw qoderHttpError('qoder_http_auth_decrypt_failed', 'qoder_http_auth_decrypt_failed', {
        cause: error
      });
    }
    let context = 0;
    try {
      context = runtime.newContext(machineId, version, plaintext);
    } catch (error) {
      throw qoderHttpError('qoder_http_context_create_failed', 'qoder_http_context_create_failed', {
        cause: error
      });
    }
    if (cachedAuth && cachedAuth.context) {
      try { runtime.freeContext(cachedAuth.context); } catch (_error) { /* best effort */ }
    }
    authCache.set(runtimeDir, { blob, machineId, context });
    return context;
  };

  const signer = {
    sign({ runtimeDir, version, endpoint, bodyJson, modelKey, modelSource, machineToken, machineType }) {
      const context = readAuthContext({ runtimeDir, version });
      let result = null;
      try {
        result = runtime.prepare(context, endpoint, bodyJson, modelKey, modelSource);
      } catch (error) {
        throw qoderHttpError('qoder_http_sign_failed', 'qoder_http_sign_failed', { cause: error });
      }
      const headers = {};
      if (result.headers instanceof Map) {
        for (const [name, value] of result.headers.entries()) {
          if (typeof name === 'string' && typeof value === 'string') headers[name] = value;
        }
      } else if (result.headers && typeof result.headers === 'object') {
        Object.assign(headers, result.headers);
      }
      // 真实客户端的 UMID 覆盖：WASM 只给 36 字符占位 + "5"，抓包里是 88 字符 token。
      if (machineToken) headers['Cosy-MachineToken'] = machineToken;
      if (machineType) headers['Cosy-MachineType'] = machineType;
      delete headers.Host;
      delete headers.host;
      delete headers['Content-Length'];
      delete headers['content-length'];
      return { url: result.url, headers, body: result.body };
    },
    dispose() {
      for (const entry of authCache.values()) {
        if (entry && entry.context) {
          try { runtime.freeContext(entry.context); } catch (_error) { /* best effort */ }
        }
      }
      authCache.clear();
    }
  };
  if (signerCache.size >= MAX_SIGNER_CACHE) {
    const oldestKey = signerCache.keys().next().value;
    const oldest = signerCache.get(oldestKey);
    if (oldest && typeof oldest.dispose === 'function') oldest.dispose();
    signerCache.delete(oldestKey);
  }
  signerCache.set(cacheKey, signer);
  return signer;
}

function disposeQoderWasmSigners() {
  for (const signer of signerCache.values()) {
    if (signer && typeof signer.dispose === 'function') signer.dispose();
  }
  signerCache.clear();
}

// ---------------------------------------------------------------------------
// Egress：账号/服务端显式代理优先；仅环境变量代理允许失败后直连（避免绕过用户显式选择）
// ---------------------------------------------------------------------------

function loadUndiciAgent() {
  try {
    const undici = require('undici');
    return typeof undici.Agent === 'function' ? undici.Agent : null;
  } catch (_error) {
    return null;
  }
}

function buildQoderDirectDispatcher({ fs, path, provider, runtimeDir, hostHomeDir, url }) {
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch (_error) {
    return { dispatcher: null, label: 'direct' };
  }
  const Agent = loadUndiciAgent();
  const ips = readQoderDnsIps({ fs, path, provider, runtimeDir, hostHomeDir, hostname });
  if (!Agent || ips.length === 0) return { dispatcher: null, label: 'direct' };
  const ip = ips[0];
  const dispatcher = new Agent({
    connect: {
      lookup(_host, _options, callback) {
        callback(null, [{ address: ip, family: 4 }]);
      }
    }
  });
  return { dispatcher, label: 'direct_ip' };
}

function resolveQoderHttpEgress({ options, account, requestJson, url, provider, runtimeDir, hostHomeDir, fs, path, deps }) {
  if (deps && (deps.qoderHttpDispatcher || deps.dispatcher)) {
    return {
      dispatcher: deps.qoderHttpDispatcher || deps.dispatcher,
      label: 'injected',
      canRetryDirect: false,
      proxyConfig: null
    };
  }
  const accountProxy = normalizeString(account && (account.proxyUrl || (account.egress && account.egress.url)));
  const proxyConfig = resolveProxyConfig(url, {
    proxyUrl: accountProxy || normalizeString(options && options.proxyUrl),
    noProxy: normalizeString(options && options.noProxy)
  });
  if (!proxyConfig.url) {
    const direct = buildQoderDirectDispatcher({ fs, path, provider, runtimeDir, hostHomeDir, url });
    return {
      dispatcher: direct.dispatcher,
      label: direct.label,
      canRetryDirect: false,
      proxyConfig
    };
  }
  let dispatcher = null;
  try {
    dispatcher = getProxyDispatcher(proxyConfig.url);
  } catch (error) {
    throw qoderHttpError('qoder_http_proxy_unavailable', 'qoder_http_proxy_unavailable', { cause: error });
  }
  if (!dispatcher) {
    throw qoderHttpError('qoder_http_proxy_unavailable', 'qoder_http_proxy_unavailable');
  }
  return {
    dispatcher,
    label: 'proxy',
    canRetryDirect: proxyConfig.source === 'env_proxy',
    proxyConfig,
    direct: buildQoderDirectDispatcher({ fs, path, provider, runtimeDir, hostHomeDir, url }),
    proxyUrl: proxyConfig.url
  };
}

function shouldRetryQoderHttpWithDirect(egress, error) {
  if (!egress || !egress.canRetryDirect || !egress.direct) return false;
  if (error && error.qoderHttpRetryDirect === true) return true;
  if (!egress.proxyConfig) return false;
  return shouldRetryWithoutProxy(egress.proxyConfig, error);
}

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

function compressQoderBody(body, deps) {
  if (typeof deps.compressQoderBody === 'function') return deps.compressQoderBody(body);
  if (typeof zlib.zstdCompressSync !== 'function') {
    throw qoderHttpError('qoder_http_zstd_unavailable', 'qoder_http_zstd_unavailable');
  }
  const params = {};
  if (zlib.constants && zlib.constants.ZSTD_c_compressionLevel) {
    params[zlib.constants.ZSTD_c_compressionLevel] = 1;
  }
  return zlib.zstdCompressSync(Buffer.from(String(body || ''), 'utf8'), { params });
}

async function buildQoderHttpRequest(options, account, requestJson, timeoutMs, deps = {}) {
  const startedAt = Date.now();
  const provider = normalizeString(account && account.provider).toLowerCase();
  if (!supportsQoderHttpTransport(provider)) {
    throw qoderHttpError('qoder_http_unsupported_provider', 'qoder_http_unsupported_provider');
  }
  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const invocation = typeof deps.resolveQoderHttpInvocation === 'function'
    ? await deps.resolveQoderHttpInvocation(options, account, requestJson, timeoutMs)
    : buildQoderCliInvocation(options, account, requestJson, timeoutMs, deps);
  const runtimeDir = normalizeString(invocation && invocation.runtimeDir);
  const cliPath = normalizeString(invocation && invocation.cliPath);
  const hostHomeDir = normalizeString(
    deps.hostHomeDir
    || (options && options.hostHomeDir)
    || (invocation && invocation.cwd)
    || nodePath.dirname(normalizePathString(deps.aiHomeDir || (options && options.aiHomeDir)) || nodePath.join(nodeOs.homedir(), '.ai_home'))
  );
  if (!runtimeDir || !cliPath) {
    throw qoderHttpError('qoder_http_invocation_incomplete', 'qoder_http_invocation_incomplete');
  }

  const version = normalizeString(deps.qoderClientVersion) || resolveQoderClientVersion(cliPath, provider);
  const layout = qoderLayout(provider, version);
  // 模型目录：账号投影优先、宿主客户端兜底（见 lib/account/qoder-model-catalog.js）。
  // 目录缺失不会在这里抛错——Auto 仍可直连；非 Auto 请求由 body builder
  // fail-closed 抛 `qoder_http_model_catalog_missing`，Strategy 据此回落 CLI。
  const catalog = typeof deps.readQoderModelCatalog === 'function'
    ? deps.readQoderModelCatalog({ provider, version, runtimeDir, hostHomeDir, cliPath, fs, path })
    : readQoderModelCatalog({ provider, version, runtimeDir, hostHomeDir, cliPath, fs, path });
  const endpointInfo = typeof deps.resolveQoderHttpEndpoint === 'function'
    ? deps.resolveQoderHttpEndpoint({ provider, version, runtimeDir, hostHomeDir, fs, path })
    : resolveQoderHttpEndpoint({ provider, version, runtimeDir, hostHomeDir, fs, path });
  const endpoint = normalizeString(endpointInfo && endpointInfo.endpoint);
  if (!endpoint) throw qoderHttpError('qoder_http_endpoint_missing', 'qoder_http_endpoint_missing');

  const umid = typeof deps.readQoderUmid === 'function'
    ? deps.readQoderUmid({ provider, runtimeDir, hostHomeDir, fs, path })
    : readQoderUmid({ provider, runtimeDir, hostHomeDir, fs, path });
  const bodyInfo = buildQoderHttpRequestBody(requestJson, {
    provider,
    version,
    sessionType: layout && layout.inference && layout.inference.sessionType,
    requestMeta: deps.requestMeta || (options && options.requestMeta),
    catalog
  });
  const bodyJson = JSON.stringify(bodyInfo.body);
  const modelSource = 'system';

  let signature = null;
  if (typeof deps.signQoderRequest === 'function') {
    signature = await deps.signQoderRequest({
      provider,
      account,
      runtimeDir,
      cliPath,
      hostHomeDir,
      version,
      endpoint,
      bodyJson,
      modelKey: bodyInfo.modelKey,
      modelSource,
      machineToken: umid && umid.machineToken,
      machineType: umid && umid.machineType,
      bodyInfo
    });
  } else {
    const signer = getQoderWasmSigner({ fs, cliPath });
    signature = signer.sign({
      runtimeDir,
      version,
      endpoint,
      bodyJson,
      modelKey: bodyInfo.modelKey,
      modelSource,
      machineToken: umid && umid.machineToken,
      machineType: umid && umid.machineType
    });
  }
  if (!signature || !signature.url || !signature.body) {
    throw qoderHttpError('qoder_http_signature_invalid', 'qoder_http_signature_invalid');
  }
  const headers = {};
  if (signature.headers instanceof Map) {
    for (const [name, value] of signature.headers.entries()) headers[name] = value;
  } else if (signature.headers && typeof signature.headers === 'object') {
    Object.assign(headers, signature.headers);
  }
  if (umid && umid.machineToken) headers['Cosy-MachineToken'] = umid.machineToken;
  if (umid && umid.machineType) headers['Cosy-MachineType'] = umid.machineType;
  delete headers.Host;
  delete headers.host;
  delete headers['Content-Length'];
  delete headers['content-length'];
  headers['Content-Encoding'] = 'zstd';
  headers.Accept = headers.Accept || headers.accept || 'text/event-stream';
  headers['Content-Type'] = headers['Content-Type'] || headers['content-type'] || 'application/json';

  const compressed = compressQoderBody(signature.body, deps);
  const egress = resolveQoderHttpEgress({
    options,
    account,
    requestJson,
    url: signature.url,
    provider,
    runtimeDir,
    hostHomeDir,
    fs,
    path,
    deps
  });

  return {
    provider,
    accountRef: normalizeString(account && account.accountRef),
    runtimeDir,
    cliPath,
    hostHomeDir,
    version,
    endpoint,
    endpointSource: normalizeString(endpointInfo && endpointInfo.source),
    url: signature.url,
    headers,
    body: compressed,
    bodyInfo,
    requestModel: normalizeString(requestJson && requestJson.model),
    modelSource: bodyInfo.modelSource,
    catalogSource: catalog && catalog.ok === true ? catalog.source : '',
    catalogReason: catalog && catalog.ok === true ? '' : normalizeString(catalog && catalog.reason),
    egress,
    requestStartedAt: startedAt,
    fetchStartedAt: Date.now()
  };
}

// ---------------------------------------------------------------------------
// SSE envelope 解析（外层 Qoder envelope → 内层 OpenAI chunk）
// ---------------------------------------------------------------------------

function createQoderSsePump() {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const drain = () => {
    const blocks = [];
    let match;
    const delimiter = /\r?\n\r?\n/;
    while ((match = delimiter.exec(buffer))) {
      blocks.push(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
    }
    return blocks;
  };
  return {
    push(value) {
      buffer += decoder.decode(value, { stream: true });
      return drain();
    },
    end() {
      buffer += decoder.decode();
      const trailing = drain();
      if (buffer.trim()) {
        trailing.push(buffer);
        buffer = '';
      }
      return trailing;
    }
  };
}

function readSseBlockData(block) {
  const lines = String(block || '').split(/\r?\n/);
  const dataLines = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  return dataLines.join('\n');
}

/**
 * 解析一条外层 envelope。
 * @returns {{kind:'chunk', chunk:object, raw:string}|{kind:'timing', timing:object}|
 *   {kind:'done'}|{kind:'ignored'}|{kind:'error', error:Error}}
 */
function parseQoderSseEnvelope(data) {
  const text = String(data || '').trim();
  if (!text) return { kind: 'ignored' };
  if (text === '[DONE]') return { kind: 'done' };
  let envelope = null;
  try {
    envelope = JSON.parse(text);
  } catch (_error) {
    // 非 JSON 的 data 帧不是 keepalive（SSE 注释用 `:` 前缀，不会进这里）：上游
    // 直接把错误文本塞进 data 时 fail closed，不能当空帧忽略后挂到超时。
    return {
      kind: 'error',
      error: qoderHttpError(
        'qoder_http_invalid_chunk',
        text.slice(0, MAX_ERROR_BODY_CHARS),
        { upstreamBody: text }
      )
    };
  }
  if (!envelope || typeof envelope !== 'object') return { kind: 'ignored' };
  if (envelope.firstTokenDuration !== undefined || envelope.totalDuration !== undefined || envelope.serverDuration !== undefined) {
    return {
      kind: 'timing',
      timing: {
        firstTokenDuration: Number(envelope.firstTokenDuration) || 0,
        totalDuration: Number(envelope.totalDuration) || 0,
        serverDuration: Number(envelope.serverDuration) || 0
      }
    };
  }
  const statusCode = Number(envelope.statusCodeValue);
  if (Number.isFinite(statusCode) && statusCode !== 200) {
    const detail = typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body || envelope);
    // 资源限流（10605 / RESOURCE_LIMIT / isQueued）附带 retryAfterSeconds，
    // 让 attempt 记录与失败策略看到「等多久」而不是把它当凭据错误。
    const queue = qoderQueueInfo(detail);
    return {
      kind: 'error',
      error: qoderHttpError('qoder_http_upstream_error', normalizeString(detail).slice(0, MAX_ERROR_BODY_CHARS), {
        statusCode,
        upstreamBody: detail,
        ...(queue ? { qoderHttpQueue: queue, retryAfterSeconds: queue.retryAfterSeconds } : {})
      })
    };
  }
  const body = envelope.body;
  if (body === undefined || body === null || body === '') return { kind: 'ignored' };
  if (typeof body === 'string' && body.trim() === '[DONE]') return { kind: 'done' };
  let chunk = body;
  let raw = '';
  if (typeof body === 'string') {
    raw = body;
    try {
      chunk = JSON.parse(body);
    } catch (_error) {
      return {
        kind: 'error',
        error: qoderHttpError(
          'qoder_http_invalid_chunk',
          normalizeString(body).slice(0, MAX_ERROR_BODY_CHARS) || 'qoder_http_invalid_chunk'
        )
      };
    }
  } else {
    raw = JSON.stringify(body);
  }
  if (!chunk || typeof chunk !== 'object') return { kind: 'ignored' };
  if (chunk.error) {
    const message = typeof chunk.error === 'string'
      ? chunk.error
      : normalizeString(chunk.error.message || chunk.error.code || JSON.stringify(chunk.error));
    const queue = qoderQueueInfo(message) || qoderQueueInfo(raw);
    return {
      kind: 'error',
      error: qoderHttpError('qoder_http_upstream_error', message.slice(0, MAX_ERROR_BODY_CHARS), {
        upstreamBody: raw,
        ...(queue ? { qoderHttpQueue: queue, retryAfterSeconds: queue.retryAfterSeconds } : {})
      })
    };
  }
  if (!Array.isArray(chunk.choices) && !chunk.usage && !chunk.id) return { kind: 'ignored' };
  return { kind: 'chunk', chunk, raw };
}

// ---------------------------------------------------------------------------
// 流读取 / 传输
// ---------------------------------------------------------------------------

function applyQoderFirstChunk(state, parsed) {
  const chunk = parsed.chunk;
  if (chunk.id) state.usageMessageId = String(chunk.id);
  if (chunk.usage && typeof chunk.usage === 'object') state.usage = chunk.usage;
  const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
  if (delta && typeof delta.content === 'string') state.outputText += delta.content;
  if (delta && typeof delta.reasoning_content === 'string') state.reasoningText += delta.reasoning_content;
  if (delta && typeof delta.reasoning === 'string') state.reasoningText += delta.reasoning;
}

async function requestQoderHttpFirstChunk(request, timeoutMs, egress, deps = {}) {
  const fetchImpl = deps.fetchQoderHttp || deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw qoderHttpError('qoder_http_fetch_unavailable', 'qoder_http_fetch_unavailable');
  }
  const controller = new AbortController();
  let externalAbort = null;
  if (deps.signal) {
    if (deps.signal.aborted) {
      throw qoderHttpError('qoder_http_aborted', 'qoder_http_aborted');
    }
    externalAbort = () => {
      try { controller.abort(deps.signal.reason); } catch (_error) { /* best effort */ }
    };
    deps.signal.addEventListener('abort', externalAbort, { once: true });
  }
  const idleTimeoutMs = Math.max(MIN_HTTP_IDLE_TIMEOUT_MS, Number(timeoutMs) || 0);
  const firstProgressTimeoutMs = egress.label === 'proxy'
    ? PROXY_FIRST_EVENT_TIMEOUT_MS
    : idleTimeoutMs;
  const watchdog = createNativeRunWatchdog({
    firstProgressTimeoutMs,
    stallTimeoutMs: idleTimeoutMs,
    maxTurnTimeoutMs: DEFAULT_HTTP_MAX_TURN_MS,
    upstreamErrorTimeoutMs: 0,
    onTimeout(info) {
      const error = qoderHttpError(
        'qoder_http_timeout',
        (info && info.message) || 'qoder_http_timeout',
        {
          qoderHttpTimeout: info,
          // 代理阶段首包超时 = 代理不可用，可直连；直连阶段超时不允许再换出口。
          qoderHttpRetryDirect: egress.label === 'proxy' && info && info.reason === 'no_first_progress'
        }
      );
      try { controller.abort(error); } catch (_error) { /* best effort */ }
    }
  });
  watchdog.start();

  const cleanupFailure = async (reader) => {
    watchdog.stop();
    if (externalAbort) {
      try { deps.signal.removeEventListener('abort', externalAbort); } catch (_error) { /* best effort */ }
    }
    if (reader) {
      try { await reader.cancel(); } catch (_error) { /* best effort */ }
    }
  };

  let response = null;
  try {
    const fetchOptions = {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal
    };
    if (egress.dispatcher) fetchOptions.dispatcher = egress.dispatcher;
    response = await fetchImpl(request.url, fetchOptions);
  } catch (error) {
    await cleanupFailure(null);
    if (error && error.name === 'AbortError' && controller.signal.reason) throw controller.signal.reason;
    throw error;
  }

  if (!response || !response.ok) {
    const statusCode = response ? response.status : 0;
    let detail = '';
    try {
      detail = response ? (await response.text()).slice(0, MAX_ERROR_BODY_CHARS) : '';
    } catch (_error) { /* best effort */ }
    await cleanupFailure(null);
    throw qoderHttpError(
      'qoder_http_http_error',
      detail || `qoder_http_http_error_${statusCode}`,
      { statusCode, upstreamBody: detail }
    );
  }

  const contentType = normalizeString(response.headers && response.headers.get && response.headers.get('content-type'));
  if (contentType && !/text\/event-stream/i.test(contentType)) {
    let detail = '';
    try { detail = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS); } catch (_error) { /* best effort */ }
    await cleanupFailure(null);
    throw qoderHttpError(
      'qoder_http_unexpected_content_type',
      detail || `qoder_http_unexpected_content_type:${contentType}`,
      { statusCode: response.status, upstreamBody: detail, contentType }
    );
  }

  const reader = response.body && typeof response.body.getReader === 'function'
    ? response.body.getReader()
    : null;
  if (!reader) {
    await cleanupFailure(null);
    throw qoderHttpError('qoder_http_response_body_missing', 'qoder_http_response_body_missing');
  }
  const pump = createQoderSsePump();
  const timing = {};
  const processBlocks = (blocks) => {
    for (let index = 0; index < blocks.length; index += 1) {
      const data = readSseBlockData(blocks[index]);
      if (!data) continue;
      const parsed = parseQoderSseEnvelope(data);
      if (parsed.kind === 'timing') {
        Object.assign(timing, parsed.timing);
        continue;
      }
      if (parsed.kind === 'error') throw parsed.error;
      if (parsed.kind === 'done') {
        throw qoderHttpError('qoder_http_empty_stream', 'qoder_http_empty_stream');
      }
      if (parsed.kind === 'chunk') {
        return { parsed, remaining: blocks.slice(index + 1) };
      }
    }
    return null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const trailing = processBlocks(pump.end());
        if (trailing) {
          watchdog.observe({ type: 'delta' });
          return { response, reader, pump, pending: trailing.remaining, timing, ...trailing.parsed, watchdog, controller, externalAbort, egress };
        }
        throw qoderHttpError('qoder_http_empty_stream', 'qoder_http_empty_stream');
      }
      const blocks = pump.push(value);
      if (blocks.length === 0) continue;
      const found = processBlocks(blocks);
      if (found) {
        watchdog.observe({ type: 'delta' });
        return { response, reader, pump, pending: found.remaining, timing, ...found.parsed, watchdog, controller, externalAbort, egress };
      }
    }
  } catch (error) {
    await cleanupFailure(reader);
    if (error && error.name === 'AbortError' && controller.signal.reason) throw controller.signal.reason;
    throw error;
  }
}

function finalizeQoderHttpUsage(state, request) {
  state.totalMs = Date.now() - request.fetchStartedAt;
  state.usageFinalized = true;
  if (state.usage && readQoderTokenCounters(state.usage)) {
    state.usageEstimated = false;
    return;
  }
  const estimated = resolveQoderUsage({
    usage: state.usage || null,
    promptText: request.bodyInfo.usagePromptText,
    outputText: `${state.outputText}${state.reasoningText ? `\n${state.reasoningText}` : ''}`,
    // `context_usage_ratio` 是相对**该模型**窗口的占比：目录里的 max_input_tokens
    // 才是正确基数（不同模型 96k / 180k / 200k / 1M 不等）。
    contextWindowTokens: request.bodyInfo.modelConfig
      && request.bodyInfo.modelConfig.max_input_tokens
  });
  if (estimated) {
    state.usage = toOpenAiUsage(estimated);
    state.usageEstimated = true;
    state.estimatedDetails = estimated;
  } else {
    state.usage = null;
    state.usageEstimated = true;
  }
}

/**
 * 对齐流式分片的 `model` 字段，并检测上游模型替换。
 *
 * 旧实现无条件把 `chunk.model` 改写成请求模型，于是上游返回 `auto`（真实发生了
 * 模型替换）也看不出来——这是掩盖，不是兼容。现在的语义：
 *   * 请求的是具体模型时，上游返回的 model 必须命中 {请求名, 目录 key, 目录展示名}，
 *     否则抛 `qoder_http_model_substituted`（首字节前 → 回落 CLI；首字节后 → 破坏流，
 *     绝不把替换后的回答伪装成成功）；
 *   * 请求的是 `auto` 时接受上游任意模型（Auto 本来就会路由到具体模型）；
 *   * 校验通过后只做展示对齐（把 key 显示成客户端请求的模型名），不改内容。
 */
function alignQoderChunkModel(chunk, request) {
  if (!chunk || typeof chunk !== 'object') return chunk;
  const upstream = normalizeString(chunk.model);
  if (!upstream) return chunk;
  const key = normalizeString(request && request.bodyInfo && request.bodyInfo.modelKey).toLowerCase();
  const accepted = new Set();
  const remember = (value) => {
    const name = normalizeString(value);
    if (name) accepted.add(name.toLowerCase());
  };
  remember(request && request.requestModel);
  remember(request && request.bodyInfo && request.bodyInfo.modelKey);
  remember(request && request.bodyInfo && request.bodyInfo.displayName);
  if (key && key !== 'auto' && !accepted.has(upstream.toLowerCase())) {
    throw qoderHttpError('qoder_http_model_substituted', `qoder_http_model_substituted:${upstream}`, {
      requestedModel: normalizeString(request && request.requestModel),
      requestedKey: key,
      upstreamModel: upstream
    });
  }
  const requested = normalizeString(request && request.requestModel)
    || normalizeString(request && request.bodyInfo && request.bodyInfo.displayName);
  if (!requested || upstream === requested) return chunk;
  return { ...chunk, model: requested };
}

async function consumeQoderHttpStream(attempt, state, body, request) {
  const { reader, pump, watchdog, externalAbort } = attempt;
  const timing = attempt.timing || {};
  let sawDone = false;
  let finished = false;
  const writeDone = () => {
    if (sawDone || body.writableEnded || body.destroyed) return;
    sawDone = true;
    body.write('data: [DONE]\n\n');
  };
  const observeChunk = (parsed) => {
    const chunk = parsed.chunk;
    if (chunk.id) state.usageMessageId = String(chunk.id);
    if (chunk.usage && typeof chunk.usage === 'object') state.usage = chunk.usage;
    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    if (delta && typeof delta.content === 'string') state.outputText += delta.content;
    if (delta && typeof delta.reasoning_content === 'string') state.reasoningText += delta.reasoning_content;
    if (delta && typeof delta.reasoning === 'string') state.reasoningText += delta.reasoning;
    // 流式分片的 model 对齐 + 替换检测（见 alignQoderChunkModel 注释）。
    // 这里抛错会让 consumeQoderHttpStream 走失败分支（首字节后不伪装成功）。
    if (chunk.model) state.upstreamModel = String(chunk.model);
    const outChunk = alignQoderChunkModel(chunk, request);
    if (!body.destroyed) body.write(`data: ${JSON.stringify(outChunk)}\n\n`);
  };
  const handleBlock = (block) => {
    const data = readSseBlockData(block);
    if (!data) return;
    const parsed = parseQoderSseEnvelope(data);
    if (parsed.kind === 'timing') {
      Object.assign(timing, parsed.timing);
      state.timing = timing;
      return;
    }
    if (parsed.kind === 'done') {
      writeDone();
      return;
    }
    if (parsed.kind === 'error') throw parsed.error;
    if (parsed.kind !== 'chunk') return;
    observeChunk(parsed);
    watchdog.observe({ type: 'delta' });
  };

  try {
    for (const block of attempt.pending || []) handleBlock(block);
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        for (const block of pump.end()) handleBlock(block);
        break;
      }
      const blocks = pump.push(value);
      for (const block of blocks) handleBlock(block);
    }
    state.timing = timing;
    finalizeQoderHttpUsage(state, request);
    writeDone();
    finished = true;
  } catch (error) {
    if (sawDone) {
      // 已经向下游发过 [DONE]：后续 timing 读取失败不能把成功改写成失败。
      finalizeQoderHttpUsage(state, request);
      finished = true;
    } else {
      // 失败流里若上游已经发过精确 usage 帧（生成已完成、尾部 timing 出错），
      // 仍要把已消耗的 token 定稿；Strategy 会在失败记账之外记录这笔用量。
      if (readQoderTokenCounters(state.usage)) finalizeQoderHttpUsage(state, request);
      let normalized = error;
      if (error && error.name === 'AbortError' && attempt.controller && attempt.controller.signal.reason) {
        normalized = attempt.controller.signal.reason;
      }
      state.error = normalized;
      try { body.destroy(normalized); } catch (_error) { /* best effort */ }
    }
  } finally {
    watchdog.stop();
    if (externalAbort) {
      try { attempt.signal && attempt.signal.removeEventListener('abort', externalAbort); } catch (_error) { /* best effort */ }
    }
    if (!state.error) {
      try { body.end(); } catch (_error) { /* best effort */ }
    }
  }
}

async function fetchQoderHttpChatCompletionStream(options, account, requestJson, timeoutMs, deps = {}) {
  const request = await buildQoderHttpRequest(options, account, requestJson, timeoutMs, deps);
  const state = {
    ok: true,
    status: 200,
    streamTransport: QODER_HTTP_TRANSPORT_ID,
    usage: null,
    usageMessageId: '',
    usageEstimated: false,
    usageFinalized: false,
    timing: null,
    outputText: '',
    reasoningText: '',
    egress: request.egress.label,
    endpoint: request.endpoint,
    endpointSource: request.endpointSource,
    version: request.version,
    modelKey: request.bodyInfo.modelKey,
    modelSource: request.bodyInfo.modelSource,
    modelMaxInputTokens: request.bodyInfo.modelConfig
      ? request.bodyInfo.modelConfig.max_input_tokens
      : 0,
    upstreamModel: '',
    requestId: request.bodyInfo.requestId,
    requestSetId: request.bodyInfo.requestSetId,
    toolCount: request.bodyInfo.toolCount,
    proxyFallback: false,
    firstTokenMs: 0,
    totalMs: 0,
    error: null
  };
  let attempt = null;
  try {
    attempt = await requestQoderHttpFirstChunk(request, timeoutMs, request.egress, deps);
  } catch (error) {
    error.qoderHttpEndpoint = request.endpoint;
    error.qoderHttpEgress = request.egress.label;
    if (shouldRetryQoderHttpWithDirect(request.egress, error)) {
      try {
        attempt = await requestQoderHttpFirstChunk(
          { ...request, egress: request.egress.direct },
          timeoutMs,
          request.egress.direct,
          deps
        );
        state.egress = request.egress.direct.label;
        state.proxyFallback = true;
      } catch (directError) {
        directError.qoderHttpEndpoint = request.endpoint;
        directError.qoderHttpEgress = request.egress.direct.label;
        throw directError;
      }
    } else {
      throw error;
    }
  }
  state.firstTokenMs = Date.now() - request.fetchStartedAt;
  state.timing = attempt.timing || {};
  applyQoderFirstChunk(state, attempt);
  const body = createSseBodyStream();
  state.body = body;
  // 首字节前做模型替换检测：命中就抛错，Strategy 回落 CLI，客户端不会看到
  // 一个「请求 qfmodel、实际 auto」却被伪装成成功的回答。
  if (attempt.chunk && attempt.chunk.model) state.upstreamModel = String(attempt.chunk.model);
  const firstChunk = alignQoderChunkModel(attempt.chunk, request);
  body.write(`data: ${JSON.stringify(firstChunk)}\n\n`);
  attempt.signal = deps.signal;
  consumeQoderHttpStream(attempt, state, body, request).catch(() => {
    // 错误已通过 body.destroy / state.error 传递；这里只防未处理 rejection。
  });
  return state;
}

function aggregateQoderHttpChunks(chunks, options = {}) {
  const contentParts = [];
  const reasoningParts = [];
  const toolCalls = new Map();
  let id = '';
  let created = 0;
  let model = '';
  let finishReason = null;
  let usage = options.usage && typeof options.usage === 'object' ? options.usage : null;
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    if (!id && chunk.id) id = String(chunk.id);
    if (!created && Number.isFinite(Number(chunk.created))) created = Number(chunk.created);
    if (!model && chunk.model) model = String(chunk.model);
    if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage;
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') contentParts.push(delta.content);
    if (typeof delta.reasoning_content === 'string') reasoningParts.push(delta.reasoning_content);
    if (typeof delta.reasoning === 'string') reasoningParts.push(delta.reasoning);
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        if (!call || typeof call !== 'object') continue;
        const index = Number.isFinite(Number(call.index)) ? Number(call.index) : toolCalls.size;
        const existing = toolCalls.get(index) || {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' }
        };
        if (call.id) existing.id = String(call.id);
        if (call.type) existing.type = String(call.type);
        const fn = call.function && typeof call.function === 'object' ? call.function : call;
        if (typeof fn.name === 'string') existing.function.name += fn.name;
        if (typeof fn.arguments === 'string') existing.function.arguments += fn.arguments;
        toolCalls.set(index, existing);
      }
    }
  }
  const message = { role: 'assistant', content: contentParts.join('') };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join('');
  if (toolCalls.size > 0) {
    message.tool_calls = Array.from(toolCalls.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call);
    if (!message.content) message.content = null;
  }
  return {
    id: id || options.fallbackId || `chatcmpl-qoder-http-${Date.now()}`,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model: options.model || model || 'auto',
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason || (toolCalls.size > 0 ? 'tool_calls' : 'stop')
    }],
    ...(usage ? { usage } : {})
  };
}

function createQoderCompletionPayloadFromStream(stream, model) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    const pump = createQoderSsePump();
    const onData = (buffer) => {
      for (const block of pump.push(buffer)) {
        const data = readSseBlockData(block);
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object') chunks.push(parsed);
        } catch (_error) { /* 非 JSON 帧忽略 */ }
      }
    };
    stream.body.on('data', onData);
    stream.body.once('error', reject);
    stream.body.once('end', () => {
      for (const block of pump.end()) {
        const data = readSseBlockData(block);
        if (!data || data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object') chunks.push(parsed);
        } catch (_error) { /* ignore */ }
      }
      const payload = aggregateQoderHttpChunks(chunks, {
        model,
        usage: stream.usage,
        fallbackId: stream.usageMessageId
      });
      if (stream.usageEstimated) {
        Object.defineProperty(payload, 'usageEstimated', { value: true, enumerable: false });
      }
      if (stream.usageMessageId) {
        Object.defineProperty(payload, 'usageMessageId', { value: stream.usageMessageId, enumerable: false });
      }
      Object.defineProperty(payload, 'qoderHttpEgress', { value: stream.egress, enumerable: false });
      Object.defineProperty(payload, 'qoderHttpFirstTokenMs', { value: stream.firstTokenMs, enumerable: false });
      Object.defineProperty(payload, 'qoderHttpTotalMs', { value: stream.totalMs, enumerable: false });
      Object.defineProperty(payload, 'qoderHttpTiming', { value: stream.timing, enumerable: false });
      Object.defineProperty(payload, 'qoderHttpEndpoint', { value: stream.endpoint, enumerable: false });
      Object.defineProperty(payload, 'qoderHttpEndpointSource', { value: stream.endpointSource, enumerable: false });
      Object.defineProperty(payload, 'qoderHttpClientVersion', { value: stream.version, enumerable: false });
      Object.defineProperty(payload, 'qoderHttpModelKey', { value: stream.modelKey, enumerable: false });
      // 目录来源与上游真实模型：观测「请求的是谁、上游实际用了谁」，
      // 不再靠改写 model 字段掩盖替换。
      Object.defineProperty(payload, 'qoderHttpModelSource', { value: stream.modelSource, enumerable: false });
      Object.defineProperty(payload, 'qoderHttpUpstreamModel', { value: stream.upstreamModel, enumerable: false });
      Object.defineProperty(payload, 'qoderHttpModelMaxInputTokens', { value: stream.modelMaxInputTokens, enumerable: false });
      Object.defineProperty(payload, 'qoderHttpToolCount', { value: stream.toolCount, enumerable: false });
      Object.defineProperty(payload, 'qoderHttpRequestId', { value: stream.requestId, enumerable: false });
      Object.defineProperty(payload, 'qoderHttpProxyFallback', { value: stream.proxyFallback, enumerable: false });
      resolve(payload);
    });
  });
}

async function fetchQoderHttpChatCompletion(options, account, requestJson, timeoutMs, deps = {}) {
  const stream = await fetchQoderHttpChatCompletionStream(options, account, requestJson, timeoutMs, deps);
  return createQoderCompletionPayloadFromStream(stream, normalizeString(requestJson && requestJson.model) || stream.modelKey);
}

module.exports = {
  QODER_HTTP_TRANSPORT_ID,
  supportsQoderHttpTransport,
  buildQoderHttpRequestBody,
  fetchQoderHttpChatCompletion,
  fetchQoderHttpChatCompletionStream,
  __private: {
    aggregateQoderHttpChunks,
    alignQoderChunkModel,
    buildQoderHttpParameters,
    createQoderSsePump,
    disposeQoderWasmSigners,
    getQoderWasmSigner,
    normalizeQoderHttpModelInfo,
    normalizeQoderHttpTools,
    parseQoderSseEnvelope,
    readQoderDnsIps,
    readQoderUmid,
    readSseBlockData,
    resolveQoderClientVersion,
    resolveQoderHttpEndpoint,
    resolveQoderHttpEgress
  }
};
