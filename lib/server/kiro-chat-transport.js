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
//   * CodeWhisperer 另有 tools 协议，本 transport 目前只做文本轮（工具调用留给后续迭代），
//     因此 harness 的工具调用在 kiro 上不可用——这是有意的范围，不是静默丢弃。

const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');

const { createKiroEventStreamParser } = require('./kiro-event-stream');

const KIRO_PROVIDER_ID = 'kiro';
const KIRO_CHAT_OPERATION = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse';
const KIRO_CHAT_CONTENT_TYPE = 'application/x-amz-json-1.0';
const DEFAULT_KIRO_REGION = 'us-east-1';
const DEFAULT_TURN_TIMEOUT_MS = 120000;
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
const IMAGE_PLACEHOLDER = '[图片附件暂不支持经 kiro 通道发送]';
const DEFAULT_CONTINUE_PROMPT = 'Continue.';

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

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') {
      parts.push(part.text);
    } else if (part.type === 'image_url' || part.type === 'input_image') {
      // CodeWhisperer 的图片走另一套（文档/图片块），本 transport 不送：显式占位，不静默丢。
      parts.push(IMAGE_PLACEHOLDER);
    }
  }
  return parts.filter(Boolean).join('\n');
}

function listRequestMessages(requestJson = {}) {
  const messages = Array.isArray(requestJson.messages) ? requestJson.messages : [];
  if (messages.length) return messages;
  // responses-wire 形态（`input: [{role, content:[{type:'input_text'}]}]`）兜底：正常情况下
  // 协议桥接已经把它转成 chat 形态，这里只是避免「拿不到任何消息 → 空 prompt」。
  const input = Array.isArray(requestJson.input) ? requestJson.input : [];
  return input
    .filter((item) => item && typeof item === 'object' && item.role)
    .map((item) => ({ role: item.role, content: item.content }));
}

/** OpenAI messages → CodeWhisperer 的 user/assistant 轮次（system 折叠进首个用户轮）。 */
function normalizeKiroTurns(requestJson = {}) {
  const systemParts = [];
  const turns = [];
  for (const message of listRequestMessages(requestJson)) {
    if (!message || typeof message !== 'object') continue;
    const role = normalizeString(message.role).toLowerCase();
    const text = extractMessageText(message.content);
    if (!text) continue;
    if (role === 'system' || role === 'developer') {
      systemParts.push(text);
      continue;
    }
    // CodeWhisperer 只有 user / assistant 两个角色（没有 tool 轮）：其余角色一律按用户输入。
    const normalized = role === 'assistant' ? 'assistant' : 'user';
    const previous = turns[turns.length - 1];
    if (previous && previous.role === normalized) previous.content = `${previous.content}\n\n${text}`;
    else turns.push({ role: normalized, content: text });
  }
  if (systemParts.length) {
    const system = systemParts.join('\n\n');
    const firstUser = turns.find((turn) => turn.role === 'user');
    if (firstUser) firstUser.content = `${system}\n\n${firstUser.content}`;
    else turns.unshift({ role: 'user', content: system });
  }
  // currentMessage 必须是 userInputMessage：末轮是 assistant 时补一句续写指令，不丢上下文。
  if (!turns.length || turns[turns.length - 1].role !== 'user') {
    turns.push({ role: 'user', content: DEFAULT_CONTINUE_PROMPT });
  }
  return turns;
}

function buildKiroConversationState(requestJson = {}, options = {}) {
  const turns = normalizeKiroTurns(requestJson);
  const modelId = normalizeString(options.modelId || requestJson.model);
  const inputMessage = (turn) => ({
    content: turn.content,
    userInputMessageContext: {},
    ...(modelId ? { modelId } : {})
  });
  const history = turns.slice(0, -1).map((turn) => (turn.role === 'assistant'
    ? { assistantResponseMessage: { content: turn.content } }
    : { userInputMessage: inputMessage(turn) }));
  const conversationState = {
    chatTriggerType: 'MANUAL',
    conversationId: normalizeString(options.conversationId) || crypto.randomUUID(),
    currentMessage: { userInputMessage: inputMessage(turns[turns.length - 1]) }
  };
  // 空 history 会让服务端困惑（实测首轮不带 history 最稳）。
  if (history.length) conversationState.history = history;
  return conversationState;
}

function kiroError(code, message, statusCode) {
  const error = new Error(message || code);
  error.code = code;
  if (statusCode) error.kiroStatusCode = statusCode;
  return error;
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

// 上游不给 token 用量（实测无 messageMetadataEvent），因此只能估算：CJK 按 1 字 ≈ 1 token，
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

function estimateKiroUsage(requestJson, completionText) {
  const promptText = normalizeKiroTurns(requestJson).map((turn) => turn.content).join('\n');
  const promptTokens = estimateTokens(promptText);
  const completionTokens = estimateTokens(completionText);
  if (!promptTokens && !completionTokens) return null;
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}

function buildChatCompletionPayload(result, requestedModel) {
  const usage = result && result.usage;
  return {
    id: `chatcmpl-kiro-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: normalizeString(requestedModel) || 'kiro',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: (result && result.content) || '' },
      finish_reason: 'stop'
    }],
    ...(usage ? { usage } : {}),
    ...(result && result.conversationId ? { session_id: result.conversationId, sessionId: result.conversationId } : {})
  };
}

function writeSseChunk(stream, payload) {
  stream.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * 跑一轮 kiro 推理。onDelta(text) 实收增量；返回 { content, conversationId, usage }。
 * 失败抛 kiroError（带 code + kiroStatusCode），由 transport 策略映射成账号失败策略。
 */
async function runKiroTurn(options = {}, account = {}, requestJson = {}, timeoutMs = 0, deps = {}, onDelta) {
  const fetchImpl = typeof deps.fetch === 'function' ? deps.fetch : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw kiroError('kiro_transport_unavailable', 'kiro_transport_unavailable', 502);
  const accessToken = normalizeString(account.accessToken || account.access_token);
  if (!accessToken) throw kiroError('kiro_missing_access_token', 'kiro_missing_access_token', 401);

  const conversationState = buildKiroConversationState(requestJson, {
    modelId: requestJson.model,
    conversationId: deps.conversationId
  });
  const body = { conversationState };
  const profileArn = normalizeString(account.profileArn || account.profile_arn);
  if (profileArn) body.profileArn = profileArn;

  const controller = new AbortController();
  const effectiveTimeoutMs = Math.max(1000, Number(timeoutMs) || DEFAULT_TURN_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  timer.unref?.();
  const externalSignal = deps.signal || options.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal && typeof externalSignal.addEventListener === 'function') {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timer);
    if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
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
    if (controller.signal.aborted) throw kiroError('kiro_turn_timeout', `kiro_turn_timeout_${effectiveTimeoutMs}ms`, 504);
    throw kiroError('kiro_transport_failed', `kiro_transport_failed:${error && error.message}`, 502);
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
    let content = '';
    let conversationId = conversationState.conversationId;
    // 容量提示是当正文发的：先攒够 CAPACITY_NOTICE_MAX_CHARS 再决定是「提示」还是真答案。
    let noticeProbe = '';
    let noticeResolved = false;
    const emit = (text) => {
      content += text;
      if (typeof onDelta === 'function') onDelta(text);
    };
    const consumeFrame = (frame) => {
      if (frame.messageType === 'exception' || frame.exceptionType) {
        const mapped = mapKiroUpstreamError({ exceptionType: frame.exceptionType, payload: frame.payload });
        throw kiroError(mapped.code, mapped.message || mapped.code, mapped.statusCode);
      }
      if (frame.eventType === 'initial-response') {
        const document = parseJsonSafe(frame.payload);
        const id = normalizeString(document && document.conversationId);
        if (id) conversationId = id;
        return;
      }
      if (frame.eventType !== 'assistantResponseEvent') return;
      const document = parseJsonSafe(frame.payload);
      const text = document && typeof document.content === 'string' ? document.content : '';
      if (!text) return;
      if (noticeResolved) {
        emit(text);
        return;
      }
      // 前缀增量判定：仍是提示前缀 → 继续攒；一偏离就立刻放行（正常回答第一个字符就偏离）。
      const candidate = noticeProbe + text;
      if (candidate.length <= CAPACITY_NOTICE_MAX_CHARS && isKiroCapacityNoticePrefix(candidate)) {
        noticeProbe = candidate;
        return;
      }
      noticeResolved = true;
      emit(candidate);
      noticeProbe = '';
    };

    const stream = response.body;
    if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
      for await (const chunk of stream) {
        for (const frame of parser.push(chunk)) consumeFrame(frame);
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      for (const frame of parser.push(buffer)) consumeFrame(frame);
    }
    if (parser.pendingBytes > 0) throw kiroError('kiro_event_stream_truncated', 'kiro_event_stream_truncated', 502);
    if (!noticeResolved && isKiroCapacityNotice(noticeProbe)) {
      // 整段回答就是上游的容量提示 → 不是答案，按上游失败处理（冷却 + 换账号重试）。
      const mapped = mapKiroUpstreamError({ exceptionType: '', payload: JSON.stringify({ message: noticeProbe }) });
      throw kiroError(mapped.code, mapped.message, mapped.statusCode);
    }
    if (!noticeResolved && noticeProbe) emit(noticeProbe);

    return {
      content,
      conversationId,
      usage: estimateKiroUsage(requestJson, content)
    };
  } finally {
    cleanup();
  }
}


async function fetchKiroChatCompletion(options, account, requestJson = {}, timeoutMs = 0, deps = {}) {
  const result = await runKiroTurn(options, account, requestJson, timeoutMs, deps);
  return buildChatCompletionPayload(result, requestJson && requestJson.model);
}

// OpenAI Chat Completions SSE 形态的可读流（与 upstream-stream-forwarder 契约一致）：
// 每个 assistantResponseEvent 帧翻成一个 chat.completion.chunk delta。
async function fetchKiroChatCompletionStream(options, account, requestJson = {}, timeoutMs = 0, deps = {}) {
  const requestedModel = normalizeString(requestJson && requestJson.model) || 'kiro';
  const stream = new PassThrough();
  const id = `chatcmpl-kiro-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let roleSent = false;
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
  const run = runKiroTurn(options, account, requestJson, timeoutMs, deps, (delta) => {
    if (!roleSent) {
      roleSent = true;
      sendChunk({ role: 'assistant' });
    }
    sendChunk({ content: delta });
  }).then((result) => {
    if (!roleSent) sendChunk({ role: 'assistant' });
    sendChunk({}, 'stop', {
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.conversationId ? { session_id: result.conversationId, sessionId: result.conversationId } : {})
    });
    stream.write('data: [DONE]\n\n');
    stream.end();
  }).catch((error) => {
    stream.destroy(error);
  });
  // 防未处理 rejection：错误已通过 stream.destroy 传给消费方（策略层据此记账）。
  run.catch(() => {});
  return { ok: true, status: 200, body: stream };
}

module.exports = {
  KIRO_CHAT_OPERATION,
  KIRO_PROVIDER_ID,
  supportsKiroChatTransport,
  resolveKiroChatEndpoint,
  resolveKiroRegion,
  buildKiroConversationState,
  normalizeKiroTurns,
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
    extractMessageText,
    listRequestMessages,
    estimateTokens
  }
};

