'use strict';

// kiro 的推理通道：Amazon CodeWhisperer **流式 RPC**（纯 HTTP，不需要本地 CLI / 桌面 App）。
//
// 历史 bug（2026-10-16 修）：kiro 在网关里被当成普通 OpenAI 兼容上游 —— 池记录的 base URL
// 是 `https://q.us-east-1.amazonaws.com`，通用 transport 把 `POST <base>/chat/completions`
// 配 `content-type: application/json` 发过去，AWS 回
// `com.amazon.coral.service#UnknownOperationException`，而且**以 200 带出来**。表现就是
// 「kiro 会话一直失败」，界面上看到的是上游文案（含容量提示 "We're currently experiencing
// high demand…"）。
//
// 正确形状（本机实测 2026-10-16，AWS Builder ID 账号，claude-sonnet-4.5 / 4 / haiku-4.5）：
//   POST https://codewhisperer.<region>.amazonaws.com/
//   authorization: Bearer <access_token>
//   content-type: application/x-amz-json-1.0     ← 必须；application/json 会被判未知操作
//   x-amz-target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse
//   body: { conversationState: { chatTriggerType:'MANUAL', conversationId,
//           history: [ {userInputMessage:{content,userInputMessageContext:{},modelId}}
//                    | {assistantResponseMessage:{content}} ],
//           currentMessage: { userInputMessage: { content, userInputMessageContext:{}, modelId } } } }
//   → 200 application/vnd.amazon.eventstream（帧解码见 kiro-event-stream.js）
//
// 实测事实（决定本模块的形状）：
//   * 多轮靠 history 回放：同 conversationId 的第二轮能正确引用第一轮内容（无需服务端状态）；
//   * 响应里的 `modelId` 恒为 "auto"（上游自报口径），请求侧 modelId 照传（未知 id 也不报错）；
//   * **响应没有任何 token 用量帧** → usage 只能按字符估算，且 sourceKind 明确标注 estimated；
//   * 工具协议（2026-10-19 接入）：tools / toolUses / toolResults / images 的编码与帧解码在
//     kiro-dialect.js（Adapter）；本模块只负责 HTTP、超时、容量提示判定与 OpenAI Chat SSE 输出。
//   * 响应带 meteringEvent（credits）与 contextUsageEvent（上下文占用百分比），但没有 token 数，
//     usage 仍按字符估算（sourceKind 带 estimated）。

const { createSseBodyStream } = require('./sse-body-stream');

const { createKiroEventStreamParser } = require('./kiro-event-stream');
const { encodeKiroConversation, createKiroFrameDecoder } = require('./kiro-dialect');
const {
  KIRO_STREAM_FIRST_EVENT_TIMEOUT_MS,
  KIRO_STREAM_IDLE_TIMEOUT_MS
} = require('../cli/config/constants');

const KIRO_PROVIDER_ID = 'kiro';
const KIRO_CHAT_OPERATION = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse';
const KIRO_CHAT_CONTENT_TYPE = 'application/x-amz-json-1.0';
const DEFAULT_KIRO_REGION = 'us-east-1';
// 上游的「容量/维护」提示是当**正文**发回来的（不是异常帧），不拦就会被当成模型答案。
// 判定必须**按前缀增量**做：正常回答的第一个字符就偏离提示 → 立刻放行（流式不被牺牲）；
// 只有「整段回答就是这句提示」才判失败（避免把正常引用该句的答案误判）。
const CAPACITY_NOTICES = Object.freeze([
  "We're currently experiencing high demand, which may cause temporary errors.",
  'We are currently experiencing high demand, which may cause temporary errors.'
]);
// 提示最长 74 字符；留出余量作为「攒多久必须放行」的上限，避免任何情况下卡住流。
const CAPACITY_NOTICE_MAX_CHARS = 160;
const CAPACITY_NOTICE_PATTERN = /experiencing high demand|temporary errors|service is (?:temporarily )?unavailable|try again later/i;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function supportsKiroChatTransport(provider) {
  return normalizeString(provider).toLowerCase() === KIRO_PROVIDER_ID;
}

function resolveKiroRegion(account) {
  const region = normalizeString(account && (account.kiroRegion || account.region));
  return /^[a-z]{2}-[a-z]+-\d$/.test(region) ? region : DEFAULT_KIRO_REGION;
}

/**
 * 推理端点。账号显式给了 http(s) base URL 就用它（私有/自建端点），否则用该区域的
 * CodeWhisperer 端点。**`q.<region>.amazonaws.com` 不再作为默认值**——那是 Amazon Q 的
 * 其它面，chat 操作不在上面（实测全部 UnknownOperationException）。
 */
function resolveKiroChatEndpoint(account) {
  const base = normalizeString(account && (account.kiroChatEndpoint || account.openaiBaseUrl));
  if (/^https?:\/\//i.test(base)) {
    const trimmed = base.replace(/\/+$/, '');
    // 历史坏值：账号 env 里可能存着 `q.<region>` 主机（旧默认值），它不是 chat 端点。
    if (!/^https?:\/\/q\.[a-z0-9-]+\.amazonaws\.com$/i.test(trimmed)) return `${trimmed}/`;
  }
  return `https://codewhisperer.${resolveKiroRegion(account)}.amazonaws.com/`;
}

/**
 * 兼容旧调用方：请求 → conversationState。真正的方言规则（工具、配对、图片）在 kiro-dialect.js。
 */
function buildKiroConversationState(requestJson = {}, options = {}) {
  return encodeKiroConversation(requestJson, options).conversationState;
}

function kiroError(code, message, statusCode) {
  const error = new Error(message || code);
  error.code = code;
  if (statusCode) error.kiroStatusCode = statusCode;
  return error;
}

// undici 把真实原因放在 cause 里（fetch failed → UND_ERR_CONNECT_TIMEOUT / ECONNRESET，
// terminated → UND_ERR_SOCKET）；只取字符串 code（AbortError 的 code 是数字 20，没有信息量）。
function transportCauseCode(error) {
  const code = (error && error.cause && error.cause.code) || (error && error.code);
  return typeof code === 'string' ? code.trim() : '';
}

/**
 * 传输层失败：根本没拿到上游的答复（连接/TLS 握手超时、连接被重置、读流时 socket 断开、
 * 本地看门狗超时）。kiroStatusCode 只用于渲染给客户端的错误帧，**不是**上游状态码。
 * 旧实现把这个伪造的 502/504 当上游状态交给失败策略，结果走进「上游 5xx」分支：
 * 单次抖动就把 (账号, 模型) 冷却 5 分钟，单账号池随即整池 503 no schedulable
 * （2026-10-31：日志里的 kiro_transport_failed:fetch failed 都在 ≥10s 后出现，与 undici 的 10s
 *  连接预算吻合；该机经 fake-ip TUN 代理出网，TCP 本地秒建，TLS 握手卡在代理侧时就是这个形状）。
 * 消息末尾带上真实 code（与 describeError 的 `[code]` 同形），日志可见、策略可判。
 */
function kiroTransportError(code, message, statusCode, cause) {
  const causeCode = transportCauseCode(cause);
  const error = kiroError(code, causeCode ? `${message} [${causeCode}]` : message, statusCode);
  error.kiroTransportFailure = true;
  return error;
}

/** 交给失败策略的上游状态码：传输层失败没有上游答复，按 0 交给网络/超时判定。 */
function resolveKiroUpstreamStatus(error) {
  if (!error || error.kiroTransportFailure) return 0;
  return Number(error.kiroStatusCode) || 0;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

/** 异常帧 / 错误正文 → { code, message, statusCode }（凭据 / 限流 / 容量 / 其它）。 */
function mapKiroUpstreamError({ exceptionType, payload, fallbackStatus = 0 }) {
  const document = typeof payload === 'string' ? parseJsonSafe(payload) : payload;
  const type = normalizeString(exceptionType || (document && (document.__type || document.type)));
  const message = normalizeString(document && (document.message || document.Message)) || type;
  const reason = normalizeString(document && document.reason).toUpperCase();
  // 结构化 reason 优先（实测 ValidationException 都带 reason），再看文案。
  if (reason === 'INVALID_MODEL_ID') {
    return { code: 'model_not_found', message: `model_not_found: ${message}`, statusCode: 400 };
  }
  if (reason === 'CONTENT_LENGTH_EXCEEDS_THRESHOLD') {
    // 文案对齐 Anthropic（prompt is too long），客户端（Claude Code / Codex）据此触发自动压缩。
    return { code: 'context_length_exceeded', message: `prompt is too long: ${message}`, statusCode: 400 };
  }
  if (/credential is invalid|invalid.*(?:token|credential)|token (?:is )?expired|expired.*token|not authorized|unauthorized/i.test(message)) {
    return { code: 'kiro_credential_invalid', message, statusCode: 401 };
  }
  if (/throttl|too many requests|rate.?limit|quota/i.test(message) || /ThrottlingException/i.test(type)) {
    return { code: 'kiro_upstream_throttled', message, statusCode: 429 };
  }
  if (CAPACITY_NOTICE_PATTERN.test(message) || /ServiceUnavailable|InternalServer/i.test(type)) {
    return { code: 'kiro_upstream_capacity', message, statusCode: 503 };
  }
  return { code: type || 'kiro_upstream_error', message, statusCode: fallbackStatus || 502 };
}

/** 仍可能是容量提示的前缀（用于「先攒再判」）。 */
function isKiroCapacityNoticePrefix(text) {
  const trimmed = normalizeString(text);
  if (!trimmed) return true;
  return CAPACITY_NOTICES.some((notice) => notice.startsWith(trimmed));
}

/** 文本里包含完整提示（含被前后包裹的情况）。 */
function containsKiroCapacityNotice(text) {
  return CAPACITY_NOTICES.some((notice) => String(text || '').includes(notice));
}

function isKiroCapacityNotice(text) {
  const trimmed = normalizeString(text);
  if (!trimmed) return false;
  if (containsKiroCapacityNotice(trimmed)) return true;
  // 提示被截断（未收全）或换成别的措辞时，按「整段很短且命中容量语义」兜底。
  return trimmed.length <= CAPACITY_NOTICE_MAX_CHARS && CAPACITY_NOTICE_PATTERN.test(trimmed);
}

// 上游不给 token 用量（只有 credits 与上下文百分比），因此只能估算：CJK 按 1 字 ≈ 1 token，
// 其余按 ~4 字符 ≈ 1 token。**这是估算值**，sourceKind 会带 estimated 后缀以便追溯。
function estimateTokens(text) {
  const value = String(text || '');
  if (!value) return 0;
  let cjk = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) cjk += 1;
  }
  const other = value.length - cjk;
  return cjk + Math.ceil(other / 4);
}

function estimateKiroUsage(requestJson, completionText, encoded) {
  const promptText = (encoded || encodeKiroConversation(requestJson)).promptText;
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);
  if (!promptTokens && !completionTokens) return null;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}

function toOpenAIToolCalls(toolCalls = []) {
  return toolCalls.map((call) => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments || '{}' }
  }));
}

function resolveFinishReason(result) {
  return result && Array.isArray(result.toolCalls) && result.toolCalls.length ? 'tool_calls' : 'stop';
}

function buildChatCompletionPayload(result, requestedModel) {
  const usage = result && result.usage;
  const toolCalls = (result && result.toolCalls) || [];
  return {
    id: `chatcmpl-kiro-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: normalizeString(requestedModel) || 'kiro',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: (result && result.content) || (toolCalls.length ? null : ''),
        ...(toolCalls.length ? { tool_calls: toOpenAIToolCalls(toolCalls) } : {})
      },
      finish_reason: resolveFinishReason(result)
    }],
    ...(usage ? { usage } : {}),
    ...(result && result.conversationId ? { session_id: result.conversationId, sessionId: result.conversationId } : {})
  };
}

function writeSseChunk(stream, payload) {
  stream.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * 两段式超时（Strategy 不变，只换计时语义）：
 *   * 首个上游事件前：timeoutMs（attempt 预算）与 KIRO_STREAM_FIRST_EVENT_TIMEOUT_MS 取大；
 *   * 之后：每收到一块数据就重置的空闲超时 KIRO_STREAM_IDLE_TIMEOUT_MS。
 * 旧实现是「整轮总时长 120s」——长回答 / 长工具输入必然被截断。
 */
function createTurnWatchdog(controller, timeoutMs) {
  const firstEventMs = Math.max(1000, Number(timeoutMs) || 0, KIRO_STREAM_FIRST_EVENT_TIMEOUT_MS);
  let timer = null;
  let reason = '';
  const arm = (ms, label) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      reason = label;
      controller.abort();
    }, ms);
    timer.unref?.();
  };
  arm(firstEventMs, `kiro_turn_timeout_first_event_${firstEventMs}ms`);
  return {
    touch() { arm(KIRO_STREAM_IDLE_TIMEOUT_MS, `kiro_turn_timeout_idle_${KIRO_STREAM_IDLE_TIMEOUT_MS}ms`); },
    clear() { clearTimeout(timer); },
    get reason() { return reason; }
  };
}

/**
 * 跑一轮 kiro 推理。
 *   onText(text)   —— 实收文本增量（兼容旧调用方）；
 *   onEvent(event) —— 全部语义事件（text / thinking / tool_call_start|delta|done），按到达顺序。
 * 返回 { content, toolCalls, conversationId, usage, credits, contextUsagePercentage }。
 * 失败抛 kiroError（带 code + kiroStatusCode），由 transport 策略映射成账号失败策略；
 * 传输层失败另带 kiroTransportFailure，策略经 resolveKiroUpstreamStatus 按「无上游答复」分类。
 */
async function runKiroTurn(options = {}, account = {}, requestJson = {}, timeoutMs = 0, deps = {}, onText, onEvent) {
  const fetchImpl = typeof deps.fetch === 'function' ? deps.fetch : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw kiroError('kiro_transport_unavailable', 'kiro_transport_unavailable', 502);
  const accessToken = normalizeString(account.accessToken || account.access_token);
  if (!accessToken) throw kiroError('kiro_missing_access_token', 'kiro_missing_access_token', 401);

  const encoded = encodeKiroConversation(requestJson, {
    modelId: requestJson.model,
    conversationId: deps.conversationId
  });
  const { conversationState } = encoded;
  const body = { conversationState };
  const profileArn = normalizeString(account.profileArn || account.profile_arn);
  if (profileArn) body.profileArn = profileArn;

  const controller = new AbortController();
  const watchdog = createTurnWatchdog(controller, timeoutMs);
  const externalSignal = deps.signal || options.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal && typeof externalSignal.addEventListener === 'function') {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const cleanup = () => {
    watchdog.clear();
    if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  };
  const abortError = (error) => {
    if (watchdog.reason) return kiroTransportError('kiro_turn_timeout', watchdog.reason, 504);
    if (externalSignal && externalSignal.aborted) return kiroError('kiro_client_aborted', 'kiro_client_aborted', 499);
    return kiroTransportError('kiro_transport_failed', `kiro_transport_failed:${error && error.message}`, 502, error);
  };

  let response;
  try {
    response = await fetchImpl(resolveKiroChatEndpoint(account), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': KIRO_CHAT_CONTENT_TYPE,
        'x-amz-target': KIRO_CHAT_OPERATION
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    cleanup();
    throw abortError(error);
  }

  try {
    if (!response || response.status !== 200) {
      const text = response && typeof response.text === 'function' ? await response.text().catch(() => '') : '';
      const mapped = mapKiroUpstreamError({
        exceptionType: '',
        payload: text,
        fallbackStatus: (response && response.status) || 502
      });
      throw kiroError(mapped.code, mapped.message || mapped.code, mapped.statusCode);
    }

    const parser = createKiroEventStreamParser();
    const decoder = createKiroFrameDecoder();
    const result = {
      content: '',
      toolCalls: [],
      conversationId: conversationState.conversationId,
      usage: null,
      credits: 0,
      contextUsagePercentage: null
    };
    let toolArgumentsText = '';
    // 容量提示是当正文发的：先攒够 CAPACITY_NOTICE_MAX_CHARS 再决定是「提示」还是真答案。
    let noticeProbe = '';
    let noticeResolved = false;
    const deliver = (event) => {
      if (event.type === 'text') {
        result.content += event.text;
        if (typeof onText === 'function') onText(event.text);
      }
      if (event.type === 'tool_call_delta') toolArgumentsText += event.delta;
      if (typeof onEvent === 'function') onEvent(event);
    };
    const resolveNotice = () => {
      if (noticeResolved) return;
      noticeResolved = true;
      if (noticeProbe) deliver({ type: 'text', text: noticeProbe });
      noticeProbe = '';
    };
    const consumeEvent = (event) => {
      if (event.type === 'conversation') {
        result.conversationId = event.id;
        return;
      }
      if (event.type === 'metering') {
        result.credits += event.usage;
        return;
      }
      if (event.type === 'context_usage') {
        result.contextUsagePercentage = event.percentage;
        return;
      }
      if (event.type !== 'text') {
        // 非文本事件（工具 / 思考）说明这不是容量提示：先放行攒着的文本，保持顺序。
        resolveNotice();
        deliver(event);
        return;
      }
      if (noticeResolved) {
        deliver(event);
        return;
      }
      // 前缀增量判定：仍是提示前缀 → 继续攒；一偏离就立刻放行（正常回答第一个字符就偏离）。
      const candidate = noticeProbe + event.text;
      if (candidate.length <= CAPACITY_NOTICE_MAX_CHARS && isKiroCapacityNoticePrefix(candidate)) {
        noticeProbe = candidate;
        return;
      }
      noticeProbe = candidate;
      resolveNotice();
    };
    const consumeFrame = (frame) => {
      if (frame.messageType === 'exception' || frame.exceptionType) {
        const mapped = mapKiroUpstreamError({ exceptionType: frame.exceptionType, payload: frame.payload });
        throw kiroError(mapped.code, mapped.message || mapped.code, mapped.statusCode);
      }
      decoder.decode(frame).forEach(consumeEvent);
    };

    const stream = response.body;
    try {
      if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
        for await (const chunk of stream) {
          watchdog.touch();
          for (const frame of parser.push(chunk)) consumeFrame(frame);
        }
      } else {
        const buffer = Buffer.from(await response.arrayBuffer());
        for (const frame of parser.push(buffer)) consumeFrame(frame);
      }
    } catch (error) {
      if (error && error.kiroStatusCode) throw error;
      if (controller.signal.aborted) throw abortError(error);
      throw kiroTransportError('kiro_event_stream_failed', `kiro_event_stream_failed:${error && error.message}`, 502, error);
    }
    if (parser.pendingBytes > 0) throw kiroError('kiro_event_stream_truncated', 'kiro_event_stream_truncated', 502);
    if (!noticeResolved && isKiroCapacityNotice(noticeProbe)) {
      // 整段回答就是上游的容量提示 → 不是答案，按上游失败处理（冷却 + 换账号重试）。
      const mapped = mapKiroUpstreamError({ exceptionType: '', payload: JSON.stringify({ message: noticeProbe }) });
      throw kiroError(mapped.code, mapped.message, mapped.statusCode);
    }
    resolveNotice();
    decoder.flush().forEach(deliver);
    result.toolCalls = decoder.toolCalls;
    result.usage = estimateKiroUsage(requestJson, `${result.content}${toolArgumentsText}`, encoded);
    return result;
  } finally {
    cleanup();
  }
}

async function fetchKiroChatCompletion(options, account, requestJson = {}, timeoutMs = 0, deps = {}) {
  const result = await runKiroTurn(options, account, requestJson, timeoutMs, deps);
  return buildChatCompletionPayload(result, requestJson && requestJson.model);
}

/** 流内错误帧（OpenAI 兼容约定：`data: {"error":{...}}`），协议桥据此渲染各客户端的原生错误事件。 */
function buildStreamErrorPayload(error) {
  const statusCode = Number(error && error.kiroStatusCode) || 502;
  return {
    error: {
      message: String((error && error.message) || 'kiro_upstream_error'),
      type: statusCode === 429 ? 'rate_limit_error' : (statusCode >= 500 ? 'overloaded_error' : 'api_error'),
      code: String((error && error.code) || 'kiro_upstream_error'),
      status: statusCode
    }
  };
}

/**
 * OpenAI Chat Completions SSE 形态的可读流（与 upstream-stream-forwarder 契约一致）。
 *
 * 生命周期契约（流生命周期守卫，State Machine：pending → streaming → completed|failed）：
 *   * **首个可见事件之前**失败 → 返回的 Promise 直接 reject，策略层可以换账号重试
 *     （旧实现先返回流、后 destroy，导致 400/401/429 一律无法换号）；
 *   * 之后失败 → 写一条流内错误帧再正常结束，**绝不**伪装成 finish_reason=stop；
 *   * `completion` 解析为 { ok, result?, error? }，供策略层记账。
 */
function fetchKiroChatCompletionStream(options, account, requestJson = {}, timeoutMs = 0, deps = {}) {
  const requestedModel = normalizeString(requestJson && requestJson.model) || 'kiro';
  const stream = createSseBodyStream();
  const id = `chatcmpl-kiro-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let roleSent = false;
  let ready = false;
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const markReady = () => {
    if (ready) return;
    ready = true;
    resolveReady({ ok: true, status: 200, body: stream, completion });
  };
  const sendChunk = (delta, finishReason = null, extra = {}) => {
    writeSseChunk(stream, {
      id,
      object: 'chat.completion.chunk',
      created,
      model: requestedModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra
    });
  };
  const ensureRole = () => {
    if (roleSent) return;
    roleSent = true;
    sendChunk({ role: 'assistant' });
  };
  const onEvent = (event) => {
    if (event.type === 'text') {
      ensureRole();
      sendChunk({ content: event.text });
    } else if (event.type === 'thinking') {
      ensureRole();
      sendChunk({ reasoning_content: event.text });
    } else if (event.type === 'tool_call_start') {
      ensureRole();
      sendChunk({ tool_calls: [{ index: event.index, id: event.id, type: 'function', function: { name: event.name, arguments: '' } }] });
    } else if (event.type === 'tool_call_delta') {
      sendChunk({ tool_calls: [{ index: event.index, function: { arguments: event.delta } }] });
    } else {
      return;
    }
    markReady();
  };
  const completion = runKiroTurn(options, account, requestJson, timeoutMs, deps, null, onEvent).then((result) => {
    ensureRole();
    sendChunk({}, resolveFinishReason(result), {
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.conversationId ? { session_id: result.conversationId, sessionId: result.conversationId } : {})
    });
    stream.write('data: [DONE]\n\n');
    stream.end();
    markReady();
    return { ok: true, result };
  }, (error) => {
    if (!ready) {
      stream.destroy();
      rejectReady(error);
      return { ok: false, error };
    }
    writeSseChunk(stream, buildStreamErrorPayload(error));
    stream.end();
    return { ok: false, error };
  });
  return readyPromise;
}

module.exports = {
  KIRO_CHAT_OPERATION,
  KIRO_PROVIDER_ID,
  supportsKiroChatTransport,
  resolveKiroChatEndpoint,
  resolveKiroRegion,
  resolveKiroUpstreamStatus,
  buildKiroConversationState,
  mapKiroUpstreamError,
  isKiroCapacityNotice,
  isKiroCapacityNoticePrefix,
  containsKiroCapacityNotice,
  estimateKiroUsage,
  runKiroTurn,
  fetchKiroChatCompletion,
  fetchKiroChatCompletionStream,
  __private: {
    buildChatCompletionPayload,
    buildStreamErrorPayload,
    estimateTokens
  }
};

