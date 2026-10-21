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
//     X-Conversation-ID / X-Conversation-Message-ID / X-Conversation-Request-ID
//                                          ← 渠道校验，缺任一个 400 code 11128（见约束 5）
//
//   五条硬约束（错一条就是 400/404，且报错文案不会告诉你是哪一条）：
//     1. **路径只有 `/v2`**。`/v1/chat/completions` 实测 404 `{"error_msg":"404 Route Not Found"}`，
//        所以客户端打 aih 的 `/v1/...` 必须改写成 `/v2/...`。
//     2. **`stream` 必须为 true**。非流式实测 400
//        `{"code":11101,"msg":"Non-stream chat request is currently not supported"}`，
//        因此客户端要非流式时，本端必须**自己**向上游要流、再聚合成一个完整响应。
//     3. **`messages[0].role` 必须是 `system`**。否则实测 400
//        `{"code":11128,"msg":"first message is not system prompt"}`。
//        官方客户端恒定先发 system，裸发 user 会被安全策略拦。
//     4. **无 Bearer 直接 401**（openresty 层，连业务信封都没有）。
//     5. **会话三件套头必须非空**：`X-Conversation-ID`、`X-Conversation-Message-ID`、
//        `X-Conversation-Request-ID`。缺任一个或值为空，上游回 400
//        `{"code":11128,"msg":"request illegal"}`，displayTips 是「没通过渠道校验，可能不是
//        官方客户端发出的」。2026-10-21 用官方 CLI 2.161.4 抓包后在真上游逐项删除确认：
//        UA、x-requested-with、X-IDE-*、X-Product、X-Domain、x-stainless-*、trace 头、
//        请求体形状、TLS 栈（Node / Bun）都**不参与**校验；只有这三个头决定过不过。
//        值的格式不校验（任意非空串都行），官方取值见 buildCodebuddyFamilyConversationHeaders。
//        同一个码 11128 以前也表示「首条非 system」，现在两种语义共用，只能看 msg 区分。
//
//   成功路径的 SSE **就是标准 OpenAI `chat.completion.chunk`**（实测字段
//   `{id,model,object,created,choices,usage}`，delta 里另有 `reasoning_content`
//   / `function_call` / `refusal` / `tool_calls` / `extra_fields` 等富字段），
//   所以流式可以直接逐字节透传，不需要信封解包或协议翻译。
//
//   失败路径是腾讯统一信封 `{code,msg,requestId,displayMsg,actions}`，其中
//   `displayMsg` 带 en/zh/zh-hant 三语文案——透出 `zh` 比透 `code` 数字对用户有用。

const { isCodebuddyFamilyProvider } = require('./codebuddy-billing');
const crypto = require('node:crypto');

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
// 版本号本身不参与鉴权，只用于通过 UA 检查；运行时用 resolveCodebuddyFamilyCliVersion
// 探测本机安装的官方 CLI 版本，探测不到才回退这个常量。
//
// 注意：UA 只影响**另一条**更早的 WAF 检查（code 10085）。2026-10-21 实测，渠道校验
// （code 11128）与 UA 无关，别把两者混为一谈（见模块头约束 5）。
const CODEBUDDY_FAMILY_CLI_VERSION = '2.63.2';

/** 按官方格式拼 UA：`CLI/<版本> CodeBuddy/<版本>`。 */
function buildCodebuddyFamilyUserAgent(version) {
  const value = String(version || '').trim() || CODEBUDDY_FAMILY_CLI_VERSION;
  return `CLI/${value} CodeBuddy/${value}`;
}

// 兜底 UA 常量（未探测到版本时使用），供外部消费方直接引用。
const CODEBUDDY_FAMILY_USER_AGENT = buildCodebuddyFamilyUserAgent(CODEBUDDY_FAMILY_CLI_VERSION);

// 渠道校验要求的会话 ID 家族（约束 5）。上游只要求**非空**，不校验格式；官方客户端
// 全部用 UUIDv7 形态（`01a15ede-5927-7289-86f7-0648bbaa2d32`），本端复刻该形状。
// `X-Request-ID` 与 `X-Conversation-Message-ID` 官方**同值**，所以它也是渠道校验的一部分。
const CODEBUDDY_FAMILY_CONVERSATION_ID_HEADER = 'x-conversation-id';
const CODEBUDDY_FAMILY_CONVERSATION_MESSAGE_ID_HEADER = 'x-conversation-message-id';
const CODEBUDDY_FAMILY_CONVERSATION_REQUEST_ID_HEADER = 'x-conversation-request-id';
const CODEBUDDY_FAMILY_REQUEST_ID_HEADER = 'x-request-id';
// 官方把 `X-Root-Request-ID` 与 `X-Conversation-Request-ID` 发成同值。
const CODEBUDDY_FAMILY_ROOT_REQUEST_ID_HEADER = 'x-root-request-id';

// 官方客户端底层是 OpenAI SDK（Node 运行时），因此带一整套 `x-stainless-*` 与分布式 trace 头。
// 实测都不参与渠道校验（删掉仍 200），这里按抓包取值复刻，消掉最后一类可区分的差异。
const CODEBUDDY_FAMILY_STAINLESS_HEADERS = Object.freeze({
  'x-stainless-arch': 'arm64',
  'x-stainless-lang': 'js',
  'x-stainless-os': 'MacOS',
  'x-stainless-package-version': '6.25.0',
  'x-stainless-retry-count': '0',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v26.3.0'
});

// 官方身份头里的站点标识：`X-Domain` 取**站点根域名**（不是 origin，不带协议与端口）。
// 与 CODEBUDDY_FAMILY_INFERENCE_BASE_URLS 同源，只差一个「取 hostname」。
const CODEBUDDY_FAMILY_DOMAIN_BY_PROVIDER = Object.freeze({
  codebuddy: 'www.codebuddy.ai',
  workbuddy: 'www.workbuddy.ai',
  codebuddycn: 'copilot.tencent.com',
  workbuddycn: 'copilot.tencent.com'
});

// 上游要求首条消息是 system。客户端没给时补一条**中性**占位，而不是把第一条 user
// 改写成 system —— 后者会改变模型对角色边界的理解，属于静默语义篡改。
// 需要定制时用 CODEBUDDY_FAMILY_DEFAULT_SYSTEM_PROMPT 覆盖。
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

// 业务错误码 → 是否值得换账号重试。配额/鉴权类换号有意义；请求本身不合法的换号无意义。
const RETRYABLE_CODES = Object.freeze(new Set([
  10085,  // 请求不合法（WAF）——换个出口 IP 可能就过了
  11101,  // 非流式不支持——理论上本端已规避，出现说明上游行为变了
  // 首条非 system / 渠道校验（request illegal，约束 5）——两种语义共用此码，看 msg 区分；
  // 都属于本端应当规避的形态，出现说明上游规则又变了
  11128
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
 * 生成一个**官方同形**的 UUIDv7 标识（2026-10-21 抓包确认官方全部 ID 都是这个形状）。
 *
 * 形状：`01a15ede-5927-7289-86f7-0648bbaa2d32`
 *   - 前 48 位是毫秒时间戳（时间有序，官方值随请求递增）
 *   - 版本半字节 7、变体半字节 8
 *
 * 渠道校验只要求非空、不校验格式；这里复刻形状是为了让请求画像与官方一致
 * （见 docs/architecture/codebuddy-family-channel-verification.md 第六节）。
 *
 * @param {number} [nowMs] 注入当前时间，便于测试与复现。
 * @returns {string}
 */
function createCodebuddyFamilyConversationId(nowMs) {
  const ms = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const time = Math.max(0, Math.floor(ms)).toString(16).padStart(12, '0').slice(-12);
  // 32 位十六进制按 UUIDv7 分组：8-4-4-4-12。
  const random = crypto.randomBytes(10).toString('hex');   // 20 位
  const randA = random.slice(0, 3);                        // 填满第 3 组（版本位之外）
  const variant = ((parseInt(random.slice(3, 5), 16) & 0x3f) | 0x80)
    .toString(16).padStart(2, '0');
  return [
    time.slice(0, 8), time.slice(8, 12), `7${randA}`,
    `${variant}${random.slice(5, 7)}`, random.slice(7, 19)
  ].join('-');
}

/**
 * 渠道校验必需的会话三件套（约束 5）。三个头都必须**非空**，缺一个上游就回 11128。
 *
 * `sessionKey` 是客户端会话键：同一会话派生出同一个 conversation id（与官方客户端一致，
 * 官方同一会话复用同一个 `X-Conversation-ID`），没有会话键才每次新建。派生用 sha256
 * 而不是原样转发：会话键来自客户端、可能含任意字符，原样放进请求头既有注入风险，
 * 也会把客户端自己的会话标识外发给上游。
 *
 * `X-Conversation-Message-ID` 与 `X-Request-ID` **取同一个值**——官方就是这么发的
 * （2026-10-21 抓包：两个头逐字节相同），复刻它避免留下可区分的差异。
 *
 * @param {string} [sessionKey]
 * @param {number} [nowMs]
 * @returns {Object<string, string>}
 */
function buildCodebuddyFamilyConversationHeaders(sessionKey, nowMs) {
  const key = String(sessionKey || '').trim();
  // 会话级 ID 按会话键稳定派生；sha256 的 32 位十六进制恰好排成官方同形的 UUIDv7 骨架
  // （第 13 位固定 7、第 17 位固定 8，其余取哈希片段）。
  const digest = key
    ? crypto.createHash('sha256').update(`codebuddy-family-conversation:${key}`).digest('hex').slice(0, 32)
    : createCodebuddyFamilyConversationId(nowMs).replace(/-/g, '');
  const conversationId = [
    digest.slice(0, 8), digest.slice(8, 12), `7${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`, digest.slice(20, 32)
  ].join('-');
  // 消息级 / 请求级 ID 每次都新建，且官方让这几个头同值。
  const messageId = createCodebuddyFamilyConversationId(nowMs);
  const requestId = createCodebuddyFamilyConversationId(nowMs);
  return {
    [CODEBUDDY_FAMILY_CONVERSATION_ID_HEADER]: conversationId,
    [CODEBUDDY_FAMILY_CONVERSATION_MESSAGE_ID_HEADER]: messageId,
    [CODEBUDDY_FAMILY_REQUEST_ID_HEADER]: messageId,
    [CODEBUDDY_FAMILY_CONVERSATION_REQUEST_ID_HEADER]: requestId,
    [CODEBUDDY_FAMILY_ROOT_REQUEST_ID_HEADER]: requestId
  };
}

/**
 * 官方底层 OpenAI SDK 的分布式 trace 头（W3C traceparent + B3 双格式 + baggage）。
 *
 * 实测不参与渠道校验（删掉仍 200）；复刻它们只为让请求画像与官方一致。
 * traceId 32 位、spanId 16 位十六进制，`b3` 是 B3 单头形态（含采样位与父 span）。
 *
 * @param {number} [nowMs] 注入随机源，便于测试复现（此处不用时间，保留签名一致）。
 * @returns {Object<string, string>}
 */
function buildCodebuddyFamilyTraceHeaders() {
  const traceId = crypto.randomBytes(16).toString('hex');
  const spanId = crypto.randomBytes(8).toString('hex');
  const parentSpanId = crypto.randomBytes(8).toString('hex');
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    'x-b3-traceid': traceId,
    'x-b3-parentspanid': parentSpanId,
    'x-b3-spanid': spanId,
    'x-b3-sampled': '1',
    'x-trace-id': traceId
  };
}

/**
 * 家族上游必需的请求头。
 *
 * 只返回**附加**头；`authorization` 由通用直通链路统一写（它持有 accessToken），
 * 这里不重复设置以免两处口径分叉。调用方在通用头组装之后 Object.assign 即可。
 *
 * 三个来源要分清（代价不同，别互相顶替）：
 *   - UA / x-requested-with：更早的 WAF 检查（10085）；
 *   - 会话 ID 家族（含 X-Request-ID）：渠道校验（11128），**缺了直接 400**；
 *   - X-Product / X-IDE-* / X-Agent-* / X-User-Id / X-Domain：官方身份画像。
 *     2026-10-21 实测它们**不参与**上述两条检查（删掉仍 200），发它们是为了让请求
 *     画像与官方一致，不留下可区分的差异。
 *
 * 刻意**不发** Origin / Referer：官方 CLI 身份不发这两个头（浏览器语义头，只有桌面/VSCode
 * 身份才带）。此前本端补发它们，反而是一处与官方不符的差异。
 *
 * @param {string} provider
 * @param {object} account
 * @param {{ sessionKey?: string, nowMs?: number, uid?: string, version?: string }} [options]
 */
function buildCodebuddyFamilyUpstreamHeaders(provider, account, options = {}) {
  const normalized = normalizeProvider(provider);
  const version = String(options.version || '').trim() || CODEBUDDY_FAMILY_CLI_VERSION;
  const uid = String(options.uid || '').trim();
  const conversation = buildCodebuddyFamilyConversationHeaders(options.sessionKey, options.nowMs);
  const headers = {
    'user-agent': buildCodebuddyFamilyUserAgent(version),
    'x-requested-with': 'XMLHttpRequest',
    accept: 'application/json',
    'x-codebuddy-request': '1',
    'x-product': 'SaaS',
    'x-domain': CODEBUDDY_FAMILY_DOMAIN_BY_PROVIDER[normalized] || '',
    'x-ide-type': 'CLI',
    'x-ide-name': 'CLI',
    'x-ide-version': version,
    'x-agent-purpose': 'conversation',
    'x-agent-intent': 'craft',
    'x-agent-type': 'main',
    'x-private-data': 'false',
    ...(uid ? { 'x-user-id': uid } : {}),
    ...CODEBUDDY_FAMILY_STAINLESS_HEADERS,
    ...buildCodebuddyFamilyTraceHeaders(),
    ...conversation,
    // baggage 引用会话与请求 id，必须在它们算出来之后再拼（官方同样是引用关系）。
    baggage: `codebuddy.session_id=${conversation[CODEBUDDY_FAMILY_CONVERSATION_ID_HEADER]},`
      + `codebuddy.conversation_request_id=${conversation[CODEBUDDY_FAMILY_CONVERSATION_REQUEST_ID_HEADER]}`
  };
  // '' 只可能来自未登记的 provider（调用方已保证是家族成员），不留空头值。
  if (!headers['x-domain']) delete headers['x-domain'];
  return headers;
}

/**
 * 读本机安装的官方 CodeBuddy CLI 版本（`~/.local/share/codebuddy/versions/<版本>/`）。
 *
 * 为什么要探测而不是写死：官方 UA / `X-IDE-Version` 带的是**当前发行版版本号**，
 * 写死的常量会随官方升级越来越旧，成为一处可区分的差异。探测失败时回退常量——
 * 版本号不参与鉴权（见 CODEBUDDY_FAMILY_USER_AGENT 注释），回退不会造成功能问题。
 *
 * @param {{ fs?: object, home?: string }} [deps]
 * @returns {string} 版本号；读不到时返回 CODEBUDDY_FAMILY_CLI_VERSION
 */
function resolveCodebuddyFamilyCliVersion(deps = {}) {
  const fsImpl = deps.fs || require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const home = String(deps.home || (deps.env || process.env).AIH_HOST_HOME || os.homedir() || '').trim();
  if (!home) return CODEBUDDY_FAMILY_CLI_VERSION;
  const roots = [path.join(home, '.local', 'share', 'codebuddy', 'versions')];
  // 国内站的独立 CLI 发行包用另一个数据根（与 provider-storage-policy 的口径一致）。
  roots.push(path.join(home, '.codebuddy-cn', 'versions'));
  const found = [];
  for (const versionsDir of roots) {
    try {
      for (const name of fsImpl.readdirSync(versionsDir)) {
        if (/^\d+\.\d+\.\d+/.test(name)) found.push(name);
      }
    } catch (_error) { /* 该数据根不存在：换下一个。 */ }
  }
  if (!found.length) return CODEBUDDY_FAMILY_CLI_VERSION;
  // 目录名就是版本号；多版本共存时取最高的那个（与 CLI 自身 `install latest` 的口径一致）。
  found.sort((a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
  });
  return found[found.length - 1];
}

/**
 * 从家族账号凭据里取官方 `X-User-Id` 的值（= 凭据里的 uid，也等于 token 的 sub）。
 *
 * 只在形状完全对得上时才返回，避免把别的字段误当 uid 发出去。
 *
 * @param {object} account
 * @returns {string}
 */
function resolveCodebuddyFamilyUserId(account) {
  const native = account && (account.nativeAuth || account.native_auth);
  const credentials = native && native.credentials;
  const uid = credentials && credentials.account && credentials.account.uid;
  const value = String(uid || '').trim();
  // 官方取值是 UUID；不做严格校验（上游不校验格式），只挡空白与控制字符。
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : '';
}

/** 上游接受的字符串取值（2026-10-14 探针矩阵实测）。 */const CODEBUDDY_FAMILY_TOOL_CHOICE_STRINGS = Object.freeze(['auto', 'required', 'none']);
/** 与上游字符串**严格等价**的外部枚举别名（Mistral 系把 any 定义为 required）。 */
const CODEBUDDY_FAMILY_TOOL_CHOICE_ALIASES = Object.freeze({ any: 'required' });

/** 读一个 tools 条目声明的函数名，同时认 OpenAI 嵌套形态与 Responses 扁平形态。 */
function readCodebuddyFamilyToolName(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
  const nested = entry.function && typeof entry.function === 'object' ? entry.function.name : '';
  return String(nested || entry.name || '').trim();
}

/**
 * 把客户端的 `tool_choice` 规范成上游能收的形态，并**保住「钉住某个函数」的语义**。
 *
 * 上游把 `tool_choice` 声明成 **string**（2026-10-14 实测：发 `{"type":"function",…}` 直接
 * 400 `cannot unmarshal object into Go struct field Request.tool_choice of type string`），
 * 而 OpenAI 规范与真实客户端（Cline 等强制某个工具时）发的是 **object**。
 *
 * 「钉住某个函数」**不能只降级成裸 `required`**：那等于把「必须调用 X」放宽成「必须调用某个
 * 工具」，模型可以改用别的工具、甚至改用散文回答。对标实现一致把它判定为缺陷 ——
 * cloudflare/ai#560：「a 'model must call this tool' step silently becomes a step the model can
 * answer in prose」；raine/claude-code-proxy a638e26：「mapped to the generic 'required', which
 * lets the model choose any function」。上游既然只认字符串，就把 tools **收窄到被钉的那一个**
 * 再发 `required` —— 此时 `required` 与「必须调用 X」严格等价（cloudflare workers-ai-provider
 * 出厂实现与 CLIProxyAPI#5184 用的就是这一手法）。
 *
 * 映射表（全部 fail-open：宁可放宽语义，也不把客户端打成 400）：
 *   - `'auto' | 'required' | 'none'` → 原样（仅去空白/统一大小写）；
 *   - `'any'` → `'required'`（等价别名，不算降级）；
 *   - `{type:'function',function:{name}}`（Responses 扁平形态 `{type:'function',name}` 同）
 *     → 收窄 tools 到该函数 + `'required'`：语义等价，`pinPreserved` 标记；
 *     该函数不在 tools 里时只能退化成裸 `'required'`，客户端压根没带 tools 时直接去掉该字段。
 *     「去掉」是**刻意选择**而不是上游逼的：2026-10-14 探针实测 `tool_choice:'required'` + 空工具集
 *     上游照常 200（回散文，不报错），但空工具集下这个约束本就不可满足，透传只是留个空壳；
 *     去掉字段 + 把 `pinMissing` 记进日志，才能让「客户端钉了一个不在列表里的工具」可排查。
 *     —— 两种都标记 `pinMissing`；
 *   - `{type:'function'}` 没有名字 → 裸 `'required'`，标记 `unsupportedForm`；
 *   - `{type:'auto'|'none'|'required'}` → 同名字符串；
 *   - 其余形态（未知字符串/未知对象/数组/数字）→ `'auto'`（有 tools 时）或去掉字段（无 tools 时），
 *     并把原始形态记进 `unsupportedForm`。
 *
 * 返回 `{ toolChoice, tools, changed, pin, pinPreserved, pinMissing, unsupportedForm, downgraded }`：
 * `toolChoice === undefined` 表示应当移除该字段；`tools` 仅在真的收窄时给出新数组。
 */
function normalizeCodebuddyFamilyToolChoice(raw, tools) {
  const list = Array.isArray(tools) ? tools : null;
  const hasTools = Boolean(list && list.length);
  const base = {
    toolChoice: raw,
    tools: null,
    changed: false,
    pin: null,
    pinPreserved: false,
    pinMissing: false,
    unsupportedForm: null,
    downgraded: false
  };
  if (raw === undefined || raw === null) return base;
  // 认不出的形态：放宽成 auto（有工具时）或干脆不约束，绝不原样发上去换 400。
  const relax = (form) => ({
    ...base,
    toolChoice: hasTools ? 'auto' : undefined,
    changed: true,
    unsupportedForm: form,
    downgraded: true
  });
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if (CODEBUDDY_FAMILY_TOOL_CHOICE_STRINGS.includes(value)) {
      return { ...base, toolChoice: value, changed: value !== raw };
    }
    const alias = CODEBUDDY_FAMILY_TOOL_CHOICE_ALIASES[value];
    if (alias) return { ...base, toolChoice: alias, changed: true };
    return relax(raw);
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return relax(Array.isArray(raw) ? 'array' : typeof raw);
  const type = String(raw.type || '').trim().toLowerCase();
  if (CODEBUDDY_FAMILY_TOOL_CHOICE_STRINGS.includes(type)) {
    return { ...base, toolChoice: type, changed: true };
  }
  if (type === 'function') {
    const name = readCodebuddyFamilyToolName(raw);
    if (!name) {
      return {
        ...base,
        toolChoice: hasTools ? 'required' : undefined,
        changed: true,
        unsupportedForm: 'function_without_name',
        downgraded: true
      };
    }
    const narrowed = list ? list.filter((entry) => readCodebuddyFamilyToolName(entry) === name) : [];
    if (narrowed.length) {
      return { ...base, toolChoice: 'required', tools: narrowed, changed: true, pin: name, pinPreserved: true };
    }
    return {
      ...base,
      toolChoice: hasTools ? 'required' : undefined,
      changed: true,
      pin: name,
      pinMissing: true,
      downgraded: true
    };
  }
  return relax(type || 'unknown');
}

/**
 * 按上游硬约束改写请求体。返回**新**对象，不改动入参（调用方可能还要读原值做日志）。
 *
 * 返回 `{ body, streamed, injectedSystemPrompt, toolChoiceNormalized, toolChoiceDowngraded,
 * toolChoicePin, toolChoicePinPreserved, toolChoicePinMissing, toolChoiceUnsupportedForm,
 * annotations, degradations }`：
 *   - `streamed` 表示「已经向上游要了流」。客户端本身要非流式时它仍为 true，
 *     调用方据此知道需要把上游 SSE 聚合成单个响应（见 aggregateCodebuddyFamilySse）。
 *   - `injectedSystemPrompt` 表示补了一条 system 占位，调用方可在日志里留痕。
 *   - `toolChoiceNormalized` / `toolChoiceDowngraded` 表示 `tool_choice` 被改写、以及
 *     其中发生了语义降级（钉选没能保住）；`toolChoicePin` / `toolChoicePinPreserved` /
 *     `toolChoicePinMissing` / `toolChoiceUnsupportedForm` 给出具体改写的形状，同样供日志留痕。
 *   - `annotations` 是**结论 → 注解键**的完整映射（`codebuddyFamily*` 命名空间）。调用点
 *     整体并入 attempt 注解袋子，所以这里加结论就等于日志里能查到，不存在漏接线。
 *   - `degradations` 是**丢信息**的改写码（`tool_choice_pin_missing` /
 *     `tool_choice_unsupported_form`），调用点据此给客户端回 `x-aih-degradations` 响应头：
 *     日志能查到不代表客户端知道，这两条路都要走。等价改写与纯增补不进这个列表。
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
  const toolChoice = normalizeCodebuddyFamilyToolChoice(source.tool_choice, source.tools);
  const body = { ...source, messages, stream: true };
  if (toolChoice.changed) {
    if (toolChoice.toolChoice === undefined) delete body.tool_choice;
    else body.tool_choice = toolChoice.toolChoice;
  }
  // 钉选靠「收窄 tools」保住语义：只有真的收窄了才改写 tools，其余情况原样保留客户端工具集。
  if (toolChoice.pinPreserved && toolChoice.tools) body.tools = toolChoice.tools;
  // 结论 → 注解键的映射在**这里**声明（全仓库唯一一份）。调用点把整张表并入注解袋子，
  // 因此新增一个结论不需要回到调用点补一行——「代码里记了、日志里查不到」在结构上不可能。
  const annotations = {
    codebuddyFamilyInjectedSystemPrompt: injectedSystemPrompt,
    codebuddyFamilyToolChoice: body.tool_choice,
    codebuddyFamilyToolChoiceNormalized: toolChoice.changed,
    codebuddyFamilyToolChoiceDowngraded: toolChoice.downgraded,
    codebuddyFamilyToolChoicePin: toolChoice.pin || undefined,
    codebuddyFamilyToolChoicePinPreserved: toolChoice.pinPreserved,
    codebuddyFamilyToolChoicePinMissing: toolChoice.pinMissing,
    codebuddyFamilyToolChoiceUnsupportedForm: toolChoice.unsupportedForm || undefined,
    codebuddyFamilyToolChoiceNarrowedTools: toolChoice.pinPreserved && Array.isArray(body.tools)
      ? body.tools.length
      : undefined
  };
  // 只列**丢信息**的改写——客户端据此知道「它要求的语义没有被完整执行」。
  // 等价改写（any → required）与纯增补（补一条 system 占位）都不算有损，因此不进这个列表。
  const degradations = [];
  if (toolChoice.pinMissing) degradations.push('tool_choice_pin_missing');
  if (toolChoice.unsupportedForm) degradations.push('tool_choice_unsupported_form');
  return {
    body,
    streamed: true,
    injectedSystemPrompt,
    toolChoiceNormalized: toolChoice.changed,
    toolChoiceDowngraded: toolChoice.downgraded,
    toolChoicePin: toolChoice.pin || undefined,
    toolChoicePinPreserved: toolChoice.pinPreserved,
    toolChoicePinMissing: toolChoice.pinMissing,
    toolChoiceUnsupportedForm: toolChoice.unsupportedForm || undefined,
    annotations,
    degradations
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
 * 判定一段腾讯信封是否是**渠道校验**失败。
 *
 * 11128 有两种语义：「first message is not system prompt」（旧）与「request illegal」
 * （渠道校验，2026-10-21 起）。同一个码，只能看 msg 区分。
 *
 * @param {object} envelope 解析后的信封对象
 * @returns {boolean}
 */
function isCodebuddyFamilyChannelVerification(envelope) {
  if (!envelope || Number(envelope.code) !== 11128) return false;
  const msg = String(envelope.msg || '').toLowerCase();
  return msg.includes('request illegal') || msg.includes('unapproved channel') || msg.includes('channel');
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
 *
 * `retryable` 会为渠道校验失败（11128 + "request illegal"）撤销：那条拒绝由请求形态
 * 决定，换账号只会拿到同一张拒绝，还会给每个账号挂上模型冷却。
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
  const retryable = Number.isFinite(code) && RETRYABLE_CODES.has(code)
    && !isCodebuddyFamilyChannelVerification(parsed);
  return {
    ok: false,
    code: Number.isFinite(code) ? code : null,
    message,
    retryable
  };
}

module.exports = {
  CODEBUDDY_FAMILY_INFERENCE_BASE_URLS,
  CODEBUDDY_FAMILY_CHAT_PATH,
  CODEBUDDY_FAMILY_USER_AGENT,
  CODEBUDDY_FAMILY_CLI_VERSION,
  buildCodebuddyFamilyUserAgent,
  DEFAULT_SYSTEM_PROMPT,
  resolveCodebuddyFamilyInferenceBaseUrl,
  resolveCodebuddyFamilyOrigin,
  resolveCodebuddyFamilyInferencePath,
  buildCodebuddyFamilyUpstreamHeaders,
  buildCodebuddyFamilyConversationHeaders,
  buildCodebuddyFamilyTraceHeaders,
  createCodebuddyFamilyConversationId,
  resolveCodebuddyFamilyUserId,
  resolveCodebuddyFamilyCliVersion,
  adaptCodebuddyFamilyChatRequest,
  normalizeCodebuddyFamilyToolChoice,
  aggregateCodebuddyFamilySse,
  parseCodebuddyFamilyError,
  isCodebuddyFamilyChannelVerification
};
