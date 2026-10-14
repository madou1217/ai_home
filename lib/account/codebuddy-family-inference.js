'use strict';

// CodeBuddy / WorkBuddy 家族的**推理**端点契约（与 codebuddy-billing.js 的余额端点并列）。
//
// 与 qoder 不同，这个家族**有**可直连的 HTTP 推理端点，所以 relay 走普通 HTTP 直通，
// 不需要 CLI 子进程桥接。契约由 2026-10-14 对本机真实账号的实测确定（探针只输出形状，
// 不落 token），实测结论如下：
//
//   POST {base}/v2/chat/completions
//     Authorization: Bearer <共享 .info 里的 accessToken>
//     Content-Type: application/json
//     User-Agent: <真实客户端 UA>          ← 脚本 UA 会被网关 403（code 10085）
//     Origin / Referer: {base}
//     X-Requested-With: XMLHttpRequest
//
//   四条硬约束（错一条就是 400/404，且报错文案不会告诉你是哪一条）：
//     1. **路径只有 `/v2`**。`/v1/chat/completions` 实测 404 `{"error_msg":"404 Route Not Found"}`，
//        所以客户端打 aih 的 `/v1/...` 必须改写成 `/v2/...`。
//     2. **`stream` 必须为 true**。非流式实测 400
//        `{"code":11101,"msg":"Non-stream chat request is currently not supported"}`，
//        因此客户端要非流式时，本端必须**自己**向上游要流、再聚合成一个完整响应。
//     3. **`messages[0].role` 必须是 `system`**。否则实测 400
//        `{"code":11128,"msg":"first message is not system prompt"}`。
//        官方客户端恒定先发 system，裸发 user 会被安全策略拦。
//     4. **无 Bearer 直接 401**（openresty 层，连业务信封都没有）。
//
//   成功路径的 SSE **就是标准 OpenAI `chat.completion.chunk`**（实测字段
//   `{id,model,object,created,choices,usage}`，delta 里另有 `reasoning_content`
//   / `function_call` / `refusal` / `tool_calls` / `extra_fields` 等富字段），
//   所以流式可以直接逐字节透传，不需要信封解包或协议翻译。
//
//   失败路径是腾讯统一信封 `{code,msg,requestId,displayMsg,actions}`，其中
//   `displayMsg` 带 en/zh/zh-hant 三语文案——透出 `zh` 比透 `code` 数字对用户有用。

const { isCodebuddyFamilyProvider } = require('./codebuddy-billing');

// 发行版级推理 endpoint。国内站两支共用 copilot.tencent.com，国际站两支各用自己站点域名。
// 与 CODEBUDDY_FAMILY_BILLING_ENDPOINTS 同源（同一套站点，只是路径不同），但刻意分开
// 声明：计费端点变化与推理端点变化是两件独立的事，合并会让人误以为必须一起改。
const CODEBUDDY_FAMILY_INFERENCE_BASE_URLS = Object.freeze({
  codebuddy: 'https://www.codebuddy.ai',
  workbuddy: 'https://www.workbuddy.ai',
  codebuddycn: 'https://copilot.tencent.com',
  workbuddycn: 'https://copilot.tencent.com'
});

// 上游只认 `/v2/chat/completions`（见上文约束 1）。
const CODEBUDDY_FAMILY_CHAT_PATH = '/v2/chat/completions';

// 网关对脚本 UA 返回 403 `{"code":10085,"msg":"请求不合法"}`（与余额接口同一道 WAF）。
// 取内嵌 runtime 上报的版本号形态；版本号本身不参与鉴权，只用于通过 UA 检查。
const CODEBUDDY_FAMILY_USER_AGENT = 'CLI/2.63.2 CodeBuddy/2.63.2';

// 上游要求首条消息是 system。客户端没给时补一条**中性**占位，而不是把第一条 user
// 改写成 system —— 后者会改变模型对角色边界的理解，属于静默语义篡改。
// 需要定制时用 CODEBUDDY_FAMILY_DEFAULT_SYSTEM_PROMPT 覆盖。
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

// 业务错误码 → 是否值得换账号重试。配额/鉴权类换号有意义；请求本身不合法的换号无意义。
const RETRYABLE_CODES = Object.freeze(new Set([
  10085,  // 请求不合法（WAF）——换个出口 IP 可能就过了
  11101,  // 非流式不支持——理论上本端已规避，出现说明上游行为变了
  11128   // 首条非 system——同上，属于本端应当规避的形态
]));

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function resolveDefaultSystemPrompt(env = process.env) {
  const configured = String((env && env.CODEBUDDY_FAMILY_DEFAULT_SYSTEM_PROMPT) || '').trim();
  return configured || DEFAULT_SYSTEM_PROMPT;
}

// 账号级 base URL 覆盖优先（与 grok/kimi/kiro/zcode 的口径一致：api-key 账号可自带
// CODEBUDDY_BASE_URL）。'' 表示该 provider 不属于本家族。
function resolveCodebuddyFamilyInferenceBaseUrl(provider, account) {
  const normalized = normalizeProvider(provider);
  if (!isCodebuddyFamilyProvider(normalized)) return '';
  const fromAccount = String(
    account && (account.openaiBaseUrl || account.baseUrl) || ''
  ).trim();
  const base = fromAccount || CODEBUDDY_FAMILY_INFERENCE_BASE_URLS[normalized] || '';
  return base.replace(/\/+$/, '');
}

// 站点 origin，用于 Origin / Referer 头。带端口时保留端口。
function resolveCodebuddyFamilyOrigin(provider, account) {
  const base = resolveCodebuddyFamilyInferenceBaseUrl(provider, account);
  if (!base) return '';
  try {
    return new URL(base).origin;
  } catch (_error) {
    return base;
  }
}

/**
 * 把客户端打到 aih 的路径改写成上游路径。
 *
 * 客户端说 OpenAI 协议时会用 `/v1/chat/completions`；上游只有 `/v2/chat/completions`。
 * 只改写 chat completions 这一条 —— 家族没有其他可用推理路径，把任意 `/v1/*` 一律
 * 抬成 `/v2/*` 会把未知路径伪装成存在的路径，报错反而更难查。
 */
function resolveCodebuddyFamilyInferencePath(provider, rawPath) {
  const normalized = normalizeProvider(provider);
  if (!isCodebuddyFamilyProvider(normalized)) return String(rawPath || '') || '/';
  const path = String(rawPath || '').trim() || '/';
  const withoutQuery = path.split('?')[0].replace(/\/+$/, '') || '/';
  const query = path.slice(withoutQuery.length);
  if (withoutQuery === '/v1/chat/completions' || withoutQuery === '/chat/completions') {
    return CODEBUDDY_FAMILY_CHAT_PATH + query;
  }
  return path;
}

/**
 * 家族上游必需的请求头。
 *
 * 只返回**附加**头；`authorization` 由通用直通链路统一写（它持有 accessToken），
 * 这里不重复设置以免两处口径分叉。调用方在通用头组装之后 Object.assign 即可。
 */
function buildCodebuddyFamilyUpstreamHeaders(provider, account) {
  const origin = resolveCodebuddyFamilyOrigin(provider, account);
  const headers = {
    'user-agent': CODEBUDDY_FAMILY_USER_AGENT,
    'x-requested-with': 'XMLHttpRequest',
    accept: 'application/json, text/plain, */*'
  };
  if (origin) {
    headers.origin = origin;
    headers.referer = `${origin}/`;
  }
  return headers;
}

/**
 * 把客户端的 `tool_choice` 规范成上游能收的形态。
 *
 * 上游把 `tool_choice` 声明成 **string**（2026-10-14 实测：发 `{"type":"function",…}` 直接
 * 400 `cannot unmarshal object into Go struct field Request.tool_choice of type string`），
 * 而 OpenAI 规范与真实客户端（Cline 等强制某个工具时）发的是 **object**。
 * 这里做忠实降级，而不是把 object 原样发上去换一个 400：
 *   - `{type:'auto'|'none'|'required'}` → 同名字符串；
 *   - `{type:'function',function:{name}}` → `'required'`：上游没有「指定单个函数」的形态，
 *     强制某个具体函数只能降级成强制一次工具调用（语义更弱，但请求不会被拒）；
 *   - 认不出的对象形态 → 移除该字段（等价于上游默认 auto），同样留痕。
 *
 * 返回 `{ toolChoice, changed, downgraded }`；`toolChoice === undefined` 表示应当移除该字段。
 */
function normalizeCodebuddyFamilyToolChoice(raw) {
  if (raw === undefined || raw === null) return { toolChoice: raw, changed: false, downgraded: false };
  if (typeof raw === 'string') return { toolChoice: raw, changed: false, downgraded: false };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { toolChoice: undefined, changed: true, downgraded: true };
  }
  const type = String(raw.type || '').trim().toLowerCase();
  if (type === 'auto' || type === 'none' || type === 'required') {
    return { toolChoice: type, changed: true, downgraded: false };
  }
  if (type === 'function') return { toolChoice: 'required', changed: true, downgraded: true };
  return { toolChoice: undefined, changed: true, downgraded: true };
}

/**
 * 按上游硬约束改写请求体。返回**新**对象，不改动入参（调用方可能还要读原值做日志）。
 *
 * 返回 `{ body, streamed, injectedSystemPrompt, toolChoiceNormalized, toolChoiceDowngraded }`：
 *   - `streamed` 表示「已经向上游要了流」。客户端本身要非流式时它仍为 true，
 *     调用方据此知道需要把上游 SSE 聚合成单个响应（见 aggregateCodebuddyFamilySse）。
 *   - `injectedSystemPrompt` 表示补了一条 system 占位，调用方可在日志里留痕。
 *   - `toolChoiceNormalized` / `toolChoiceDowngraded` 表示 `tool_choice` 被改写、以及
 *     其中发生了语义降级（指定单函数 → 强制一次工具调用），同样供日志留痕。
 */
function adaptCodebuddyFamilyChatRequest(requestJson, options = {}) {
  const source = requestJson && typeof requestJson === 'object' && !Array.isArray(requestJson)
    ? requestJson
    : {};
  const messages = Array.isArray(source.messages) ? source.messages.slice() : [];
  let injectedSystemPrompt = false;
  const first = messages[0];
  const firstRole = String(first && first.role || '').trim().toLowerCase();
  if (firstRole !== 'system') {
    const env = options.env || process.env;
    messages.unshift({ role: 'system', content: resolveDefaultSystemPrompt(env) });
    injectedSystemPrompt = true;
  }
  const toolChoice = normalizeCodebuddyFamilyToolChoice(source.tool_choice);
  const body = { ...source, messages, stream: true };
  if (toolChoice.changed) {
    if (toolChoice.toolChoice === undefined) delete body.tool_choice;
    else body.tool_choice = toolChoice.toolChoice;
  }
  return {
    body,
    streamed: true,
    injectedSystemPrompt,
    toolChoiceNormalized: toolChoice.changed,
    toolChoiceDowngraded: toolChoice.downgraded
  };
}

/**
 * 按 `index` 归并一帧 `delta.tool_calls[]`。
 *
 * 上游的工具调用走**标准 OpenAI 流式形态**（2026-10-14 实测）：首帧给
 * `{index,id,type,function:{name,arguments:''}}`，随后按帧下发 `arguments` 分片，
 * `index` 区分并行调用，末帧 `finish_reason` 为 `tool_calls`。
 * 同一帧里还会带一个 `function_call:{name:'',arguments:''}` 的**空占位**（历史字段），
 * 那是另一条归并链（mergeLegacyFunctionCallDelta）的事，内容为空时不得凭空造出字段。
 */
function mergeToolCallDelta(accumulator, delta) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return;
  const index = Number.isFinite(Number(delta.index)) ? Number(delta.index) : 0;
  const current = accumulator.get(index) || { index, id: '', type: 'function', name: '', arguments: '' };
  if (typeof delta.id === 'string' && delta.id && !current.id) current.id = delta.id;
  if (typeof delta.type === 'string' && delta.type) current.type = delta.type;
  const fn = delta.function && typeof delta.function === 'object' ? delta.function : null;
  if (fn) {
    if (typeof fn.name === 'string' && fn.name && !current.name) current.name = fn.name;
    if (typeof fn.arguments === 'string' && fn.arguments) current.arguments += fn.arguments;
  }
  accumulator.set(index, current);
}

/**
 * 归并历史单工具形态 `delta.function_call`。内容全空时返回原值（保持 `null`），
 * 于是聚合结果里不会多出一个空的 `function_call` 字段。
 */
function mergeLegacyFunctionCallDelta(current, delta) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return current;
  const name = typeof delta.name === 'string' ? delta.name : '';
  const args = typeof delta.arguments === 'string' ? delta.arguments : '';
  if (!name && !args) return current;
  const base = current || { name: '', arguments: '' };
  return { name: base.name || name, arguments: base.arguments + args };
}

/**
 * 把上游 SSE 文本聚合成一个非流式 `chat.completion`。
 *
 * 客户端要非流式、而上游只给流（约束 2），这是唯一能同时满足两边的做法。
 * 累积 `delta.content`、`delta.tool_calls`（含历史 `function_call`）与最后一次出现的
 * `usage`；`reasoning_content` 等富字段不属于 OpenAI chat.completion 的约定字段，
 * 聚合时丢弃（流式路径照常透传）。
 *
 * 工具调用必须折叠进 `message.tool_calls`：上游把工具调用放在流式 delta 里，
 * 丢掉它会让客户端收到 `finish_reason: 'tool_calls'` 却没有任何工具可执行 ——
 * 表现是「模型回答为空」，与「模型真的没说话」无法区分。
 *
 * 返回 `{ payload, sawDone, sawChunk }`；判定「空回答」必须同时看
 * `message.content` 与 `message.tool_calls`：纯工具调用回合的 `content` 本来就是空串。
 */
function aggregateCodebuddyFamilySse(sseText) {
  const text = String(sseText || '');
  let id = '';
  let model = '';
  let created = 0;
  let content = '';
  let finishReason = 'stop';
  let usage;
  let sawDone = false;
  let sawChunk = false;
  const toolCallsByIndex = new Map();
  let legacyFunctionCall = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') { sawDone = true; continue; }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (_error) {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    sawChunk = true;
    if (parsed.id) id = String(parsed.id);
    if (parsed.model) model = String(parsed.model);
    if (Number.isFinite(Number(parsed.created))) created = Number(parsed.created);
    if (parsed.usage && typeof parsed.usage === 'object') usage = parsed.usage;
    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    for (const choice of choices) {
      const delta = choice && choice.delta;
      if (delta && typeof delta.content === 'string') content += delta.content;
      if (delta) {
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) mergeToolCallDelta(toolCallsByIndex, call);
        }
        legacyFunctionCall = mergeLegacyFunctionCallDelta(legacyFunctionCall, delta.function_call);
      }
      if (choice && choice.finish_reason) finishReason = String(choice.finish_reason);
    }
  }

  // 非流式 `message.tool_calls[]` 按 OpenAI 约定不带 `index`（那是流式 delta 的分片序号），
  // 也不替上游编造 `id`：上游没给就不写这个键，而不是塞一个假的。
  const toolCalls = Array.from(toolCallsByIndex.values())
    .sort((a, b) => a.index - b.index)
    .map((call) => ({
      ...(call.id ? { id: call.id } : {}),
      type: call.type,
      function: { name: call.name, arguments: call.arguments }
    }));
  const message = { role: 'assistant', content };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (legacyFunctionCall) message.function_call = legacyFunctionCall;

  const payload = {
    id: id || `chatcmpl-codebuddy-${Date.now()}`,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model: model || 'unknown',
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason
    }],
    ...(usage ? { usage } : {})
  };
  return { payload, sawDone, sawChunk };
}

/**
 * 腾讯信封 → 可读错误。
 *
 * 成功路径不走这里（它是标准 OpenAI SSE）。失败时上游给的是
 * `{code,msg,requestId,displayMsg:{en,zh,zh-hant},actions}`；直接透 `code` 数字
 * 对用户没有意义，`msg` 又常常是英文且偏内部（如 "first message is not system prompt"），
 * 所以优先取 `displayMsg.zh`，回退 `msg`，再回退状态码。
 *
 * 返回 `{ ok, code, message, retryable }`；`ok: true` 表示这段文本不是信封错误。
 */
function parseCodebuddyFamilyError(status, bodyText) {
  const text = String(bodyText || '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // 非信封（例如 openresty 的 401 HTML）：状态码本身就是全部信息。
    return {
      ok: false,
      code: null,
      message: text ? text.slice(0, 300) : `upstream_status_${status}`,
      retryable: Number(status) >= 500
    };
  }
  // 没有 code 字段说明它不是腾讯信封（可能是标准 OpenAI 错误体），交给调用方原样处理。
  if (parsed.code === undefined) return { ok: true, code: null, message: '', retryable: false };
  const code = Number(parsed.code);
  const display = parsed.displayMsg && typeof parsed.displayMsg === 'object' ? parsed.displayMsg : null;
  const message = String(
    (display && (display.zh || display['zh-hant'] || display.en)) || parsed.msg || ''
  ).trim() || `upstream_code_${parsed.code}`;
  return {
    ok: false,
    code: Number.isFinite(code) ? code : null,
    message,
    retryable: Number.isFinite(code) ? RETRYABLE_CODES.has(code) : false
  };
}

module.exports = {
  CODEBUDDY_FAMILY_INFERENCE_BASE_URLS,
  CODEBUDDY_FAMILY_CHAT_PATH,
  CODEBUDDY_FAMILY_USER_AGENT,
  DEFAULT_SYSTEM_PROMPT,
  resolveCodebuddyFamilyInferenceBaseUrl,
  resolveCodebuddyFamilyOrigin,
  resolveCodebuddyFamilyInferencePath,
  buildCodebuddyFamilyUpstreamHeaders,
  adaptCodebuddyFamilyChatRequest,
  normalizeCodebuddyFamilyToolChoice,
  aggregateCodebuddyFamilySse,
  parseCodebuddyFamilyError
};
