'use strict';

// OpenCode Zen 免费模型（`-free`）的**直连 HTTP 客户端**（2026-10-16 门禁破解后新增）。
//
// 背景：免费模型此前只能经原生 CLI 桥接（lib/server/opencode-free-cli-transport.js），
// 因为 HTTP 直打 /zen/v1 一律吃门禁 403：
//   {"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}
// 匿名 / 伪造 key / 账号真 key / 逐字节复刻旧版 CLI 头（含 UA）全部无效。2026-10-15/16
// 用两代真实客户端抓包 + 逐项对照实验（见下方"门禁三条件"）完成了完整逆向，现在是
// **HTTP 直连（本模块，首选，无进程开销）+ 原生 CLI（兜底）** 的两级结构：
//   - upstream-endpoints-transport-opencode-free-http.js 用本模块做直连；
//   - 若上游加固门禁使直连重新吃 403，transport 层会**交还**同一条链上的 CLI 通道
//     （openCodeFreeCliTransport），功能不降级、只是慢一点。
//
// ── 门禁三条件（缺一即 403，全部满足才 200）────────────────────────────────
//   ① UA 形状：`opencode/<channel>/<version>/<name>` 四段式。逐项实验：四段式全过
//      （opencode/latest/9.9.9/cli、opencode/dev/2.0.29/cli、真实抓包的
//      opencode/latest/2.0.29/cli），三段式/五段式（opencode/9.9.9/aaa/bbb）与
//      curl/8.x 全拒 —— 即 channel 与 version **内容不校验，只校验形状**。
//   ② 白名单头名之一携带会话 id：`x-session-id` / `x-session-affinity` /
//      `x-opencode-session` / `x-opencode-session-id`（实测四者任一即可；非白名单
//      头名无效）。
//   ③ 该值必须**结构合法**：`ses_` + 12 位 hex + 14 位 base62（`hello`、24 字符
//      测试值、全 a 的 26 字符值被拒；随机后缀改一字符仍过 —— **不与服务端状态校验，
//      能离线铸造**）。
//   ④ 请求必须"像 opencode 自己发的"——两条证据路径，任一满足即放行（2026-10-16 实测）：
//      (a) **agent 路径：`tools` 数组含一个 `function.name === 'read'` 的条目**。精确、
//          大小写敏感（`todoread` / `READ` / `read_file` / `Read` 都不认），位置任意，
//          描述与参数内容不校验。没有 read 时，哪怕 tools 装满 opencode 的真实工具
//          （edit/glob/grep/question/shell/write …）也一律 403；补一个空壳 read 立刻 200。
//      (b) 工具类内部请求路径：消息内容含 title 生成提示词的前 ~965 字符（≤960 全拒、
//          ≥965 全过）。opencode 自己的 title/summary 请求没有 tools，走的就是这条路。
//      本模块服务任意用户对话，走 (a)：见 ensureZenFreeGateTool（缺失时补空描述垫片）。
//   ⑤ body 必须 `stream: true`：非流式请求一律 403（真实客户端两个抓包也都是
//      stream:true + stream_options.include_usage:true）。所以上游恒流式，非流式调用方
//      由 fetchOpenCodeZenFreeChatCompletion 聚合 SSE 还原成 chat.completion。
//   另：Authorization 可省（本模块按真实客户端形态发 `Bearer public` 占位 —— 免费档
//   限流按「出口 IP × 模型」计、与 key 无关，所以不读账号凭据）。
//
// ── session id 算法（与官方 identifier.ts 复现一致）────────────────────────
//   time12 = ~(毫秒时间戳 * 4096 + counter) 的低 48 位，高位字节在前（6 字节 hex）；
//   random14 = 14 个 base62 随机字符。实测反推：真实 id 的 time12 能唯一还原出
//   铸造时刻的 (t, counter) 对，且随机段与服务端无关联。
//   注意：**不复用**网关注入的会话 id —— 门禁校验结构，aih 内部 session key 不是
//   `ses_` 形态，直接转发会 403（这里是「每次请求铸造一个新 id」，服务端不校验存在性）。
//
// 错误契约：HTTP 失败抛 {code:'HTTP_<status>', statusCode, responseBody}（与付费
// opencode-server-client 的 createHttpError 一致），供上游失败策略按正文分类；
// 429（FreeUsageLimitError，出口 IP×模型 限流）与 CLI 通道共用同一条
// upstream-failure-policy 判定。

const nodeCrypto = require('node:crypto');
const { readResponseText } = require('./response-body');
const { bareOpenCodeModelId } = require('./opencode-free-cli-transport');
const { OPENCODE_ZEN_BASE_URL } = require('./opencode-server-client');

// 免费模型专用端点（Zen v1 chat completions；诊断日志与请求共用这一个常量）。
const OPENCODE_ZEN_FREE_URL = `${OPENCODE_ZEN_BASE_URL}/chat/completions`;

// UA 年号串内容是自由的（门禁只校验四段形状，见模块头注释），这里取真实发行版形态；
// 如未来上游改为「必须近期版本」，先经 AIH_OPENCODE_ZEN_UA 逃生门热修，再回来升级常量。
const ZEN_FREE_DEFAULT_USER_AGENT = 'opencode/latest/2.0.29/cli';
const ZEN_FREE_USER_AGENT_ENV = 'AIH_OPENCODE_ZEN_UA';

const SESSION_ID_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// 与官方实现同款的进程内单调 counter（毫秒内并发铸造不撞）；2048 回绕由时间位主导。
let sessionCounter = 0;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 离线铸造结构合法的 opencode 会话 id：`ses_` + 12 hex + 14 base62
 * （算法见模块头注释；服务端只校验形状，不查存在性）。
 */
function mintOpenCodeSessionId(nowMs = Date.now()) {
  const current = BigInt(Math.trunc(Number(nowMs) || Date.now())) * 4096n
    + BigInt((sessionCounter = (sessionCounter + 1) & 0xfff));
  const value = ~current;
  let time = '';
  for (let i = 0; i < 6; i += 1) {
    time += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0');
  }
  const bytes = nodeCrypto.randomBytes(14);
  let random = '';
  for (const byte of bytes) random += SESSION_ID_CHARSET[byte % SESSION_ID_CHARSET.length];
  return `ses_${time}${random}`;
}

/** `x-opencode-project` 形态：40 位 hex（真实客户端是工程路径哈希；这里按账号稳定派生）。 */
function buildZenFreeProjectId(accountRef) {
  return nodeCrypto.createHash('sha1')
    .update(`aih-zen-free:${normalizeString(accountRef) || 'anonymous'}`)
    .digest('hex');
}

function resolveUserAgent(deps = {}) {
  const env = deps.env || process.env || {};
  return normalizeString(env[ZEN_FREE_USER_AGENT_ENV]) || ZEN_FREE_DEFAULT_USER_AGENT;
}

/**
 * 门禁头集合：UA 形状（条件①）+ 四个白名单头名同值携带同一个新铸会话 id（条件②③）。
 * 刻意不发 Accept-Encoding —— Node fetch(undici) 自行协商并透明解压；真实抓包里的
 * gzip/br/zstd 行是 Bun 客户端的产物，与门禁无关（对照实验确认）。
 */
function buildZenFreeHeaders(accountRef, deps = {}, extra = {}) {
  const sessionId = mintOpenCodeSessionId();
  const projectId = buildZenFreeProjectId(accountRef);
  return {
    authorization: 'Bearer public',
    'user-agent': resolveUserAgent(deps),
    'x-opencode-client': 'cli',
    'x-opencode-project': projectId,
    'x-opencode-session': sessionId,
    'x-opencode-session-id': sessionId,
    'x-session-affinity': sessionId,
    'x-session-id': sessionId,
    ...extra
  };
}

// 免费档门禁 ④(a)：tools 必须含 `read`（见模块头注释）。垫片形态 = 实测通过门禁且
// 不被模型调用（真实模型回复正常、零 tool_calls）的最小合法条目：空描述 + 空参数、
// 名字唯一（Zen 会拒绝重复工具名，400）。
const ZEN_FREE_GATE_TOOL_NAME = 'read';

function ensureZenFreeGateTool(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const satisfied = list.some((tool) => Boolean(
    tool && typeof tool === 'object' && tool.function && tool.function.name === ZEN_FREE_GATE_TOOL_NAME
  ));
  if (satisfied) return tools;
  return [...list, {
    type: 'function',
    function: {
      name: ZEN_FREE_GATE_TOOL_NAME,
      description: '',
      parameters: { type: 'object', properties: {} }
    }
  }];
}

/**
 * 上游请求体：与付费通道 buildOpenAIChatPayload 同语义（剥离网关注入字段、模型名
 * 回裸名），并补足免费档门禁的形状条件：
 *   - `stream:true` **强制**（门禁 ⑤：非流式一律 403；真实客户端两个抓包都是
 *     stream:true + stream_options.include_usage:true）——面向非流式调用方时由
 *     fetchOpenCodeZenFreeChatCompletion 把 SSE 聚合回 chat.completion；
 *   - `tools` 必须含 `read`（门禁 ④(a)，缺则补垫片）；
 *   - stream_options.include_usage 缺省补 true（与真实客户端同形，同时给用量记账）。
 */
function buildZenFreeChatPayload(requestJson, upstreamModel, _options = {}) {
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
  const streamOptions = safeRequest.stream_options && typeof safeRequest.stream_options === 'object'
    ? safeRequest.stream_options
    : {};
  return {
    ...safeRequest,
    model: upstreamModel,
    stream: true,
    stream_options: { include_usage: true, ...streamOptions },
    tools: ensureZenFreeGateTool(safeRequest.tools)
  };
}

function createZenFreeHttpError(status, text) {
  const error = new Error(`HTTP ${status} ${normalizeString(text)}`.trim());
  error.code = `HTTP_${status}`;
  error.statusCode = status;
  error.responseBody = String(text || '');
  return error;
}

function resolveUpstreamModel(requestJson) {
  const upstreamModel = bareOpenCodeModelId(String(requestJson && requestJson.model || ''));
  if (!upstreamModel) {
    const error = new Error('opencode_zen_free_model_required');
    error.code = 'opencode_zen_free_model_required';
    throw error;
  }
  return upstreamModel;
}

async function fetchZenFreeResponse(options, account, requestJson, timeoutMs, deps, init) {
  const fetchWithTimeout = deps.fetchWithTimeout || fetch;
  return await fetchWithTimeout(OPENCODE_ZEN_FREE_URL, {
    method: 'POST',
    headers: buildZenFreeHeaders(account && account.accountRef, deps, init.headers),
    body: init.body,
    // 客户端断开 → 中止上游请求（与 CLI 通道把 signal 透传给子进程同语义）。
    ...(init.signal ? { signal: init.signal } : {})
  }, Math.max(1, Number(timeoutMs) || 8000), {
    proxyUrl: options && options.proxyUrl,
    noProxy: options && options.noProxy
  });
}

/**
 * 把 Zen 的 SSE 聚合回一个 chat.completion 对象（门禁 ⑤ 强制流式后，非流式调用方
 * 由这里还原）。合并 delta：content / reasoning / reasoning_details（Zen 扩展）/
 * tool_calls（按 index 拼接参数分片），finish_reason 取最后一个非空值，usage 取
 * 带 usage 的收尾块。注释行（`: keep-alive`）与非 data 行忽略。
 */
function aggregateZenFreeStreamPayload(sseText) {
  const body = { id: '', created: 0, model: '' };
  let role = 'assistant';
  let content = '';
  let reasoning = '';
  const reasoningDetails = [];
  const toolCalls = [];
  let finishReason = null;
  let usage = null;
  const text = typeof sseText === 'string' ? sseText : '';
  for (const block of text.split(/\r?\n\r?\n/)) {
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join('\n').trim();
    if (!data || data === '[DONE]') continue;
    let chunk = null;
    try { chunk = JSON.parse(data); } catch (_error) { continue; }
    if (!chunk || typeof chunk !== 'object') continue;
    if (!body.id && chunk.id) body.id = String(chunk.id);
    if (!body.created && chunk.created) body.created = Number(chunk.created) || 0;
    if (!body.model && chunk.model) body.model = String(chunk.model);
    if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!choice || typeof choice !== 'object') continue;
    const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : {};
    if (delta.role) role = String(delta.role);
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
    if (Array.isArray(delta.reasoning_details)) reasoningDetails.push(...delta.reasoning_details);
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        if (!part || typeof part !== 'object') continue;
        const index = Number.isInteger(part.index) ? part.index : toolCalls.length;
        if (!toolCalls[index]) {
          toolCalls[index] = { index, id: '', type: 'function', function: { name: '', arguments: '' } };
        }
        const target = toolCalls[index];
        if (part.id) target.id = String(part.id);
        if (part.type) target.type = String(part.type);
        const fn = part.function && typeof part.function === 'object' ? part.function : {};
        if (fn.name) target.function.name += String(fn.name);
        if (typeof fn.arguments === 'string') target.function.arguments += fn.arguments;
      }
    }
    if (choice.finish_reason) finishReason = String(choice.finish_reason);
  }
  return {
    ...body,
    role,
    content,
    reasoning,
    reasoningDetails,
    toolCalls: toolCalls.filter(Boolean),
    finishReason,
    usage
  };
}

/**
 * 非流式入口：上游门禁强制 `stream:true`（非流式请求一律 403 FreeTierError，实测），
 * 所以这里对上游永远发流式请求，再把 SSE 聚合回 OpenAI Chat Completions 对象
 * （字段补全口径与付费通道一致；调用方/传输层无感）。
 */
async function fetchOpenCodeZenFreeChatCompletion(options, account, requestJson = {}, timeoutMs = 8000, deps = {}) {
  const requestedModel = String(requestJson && requestJson.model || '').trim();
  const upstreamModel = resolveUpstreamModel(requestJson);
  const res = await fetchZenFreeResponse(options, account || {}, requestJson, timeoutMs, deps, {
    headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify(buildZenFreeChatPayload(requestJson, upstreamModel)),
    signal: deps.signal
  });
  const text = await readResponseText(res);
  if (!res.ok) throw createZenFreeHttpError(res.status, text);
  const aggregated = aggregateZenFreeStreamPayload(text);
  const body = {
    id: String(aggregated.id || `chatcmpl-opencode-free-${Date.now()}`),
    object: 'chat.completion',
    created: Number(aggregated.created || Math.floor(Date.now() / 1000)),
    model: String(requestedModel || aggregated.model || upstreamModel)
  };
  body.choices = [{
    index: 0,
    message: {
      role: aggregated.role || 'assistant',
      content: aggregated.content,
      ...(aggregated.reasoning ? { reasoning: aggregated.reasoning } : {}),
      ...(aggregated.reasoningDetails.length > 0 ? { reasoning_details: aggregated.reasoningDetails } : {}),
      ...(aggregated.toolCalls.length > 0 ? { tool_calls: aggregated.toolCalls } : {})
    },
    finish_reason: aggregated.finishReason || (aggregated.toolCalls.length > 0 ? 'tool_calls' : 'stop')
  }];
  if (!aggregated.usage || typeof aggregated.usage !== 'object') {
    body.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  } else {
    body.usage = aggregated.usage;
  }
  return body;
}

/**
 * 流式：返回原始 fetch Response（`body` 是 web ReadableStream，upstream-stream-forwarder
 * 的 pipeReadableBodyToResponse 直接消费）。Zen 的 SSE 就是 OpenAI chat.completion.chunk
 * 形态（含 reasoning 扩展字段），逐字节透传即正确。
 */
async function fetchOpenCodeZenFreeChatCompletionStream(options, account, requestJson = {}, timeoutMs = 8000, deps = {}) {
  const upstreamModel = resolveUpstreamModel(requestJson);
  const res = await fetchZenFreeResponse(options, account || {}, requestJson, timeoutMs, deps, {
    headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify(buildZenFreeChatPayload(requestJson, upstreamModel)),
    signal: deps.signal
  });
  if (!res.ok) {
    const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
    throw createZenFreeHttpError(res.status, text);
  }
  return res;
}

module.exports = {
  OPENCODE_ZEN_FREE_URL,
  ZEN_FREE_DEFAULT_USER_AGENT,
  ZEN_FREE_GATE_TOOL_NAME,
  ZEN_FREE_USER_AGENT_ENV,
  aggregateZenFreeStreamPayload,
  buildZenFreeChatPayload,
  buildZenFreeHeaders,
  buildZenFreeProjectId,
  createZenFreeHttpError,
  ensureZenFreeGateTool,
  fetchOpenCodeZenFreeChatCompletion,
  fetchOpenCodeZenFreeChatCompletionStream,
  mintOpenCodeSessionId,
  __private: {
    resolveUpstreamModel
  }
};
