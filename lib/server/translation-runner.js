'use strict';

// 「AI 翻译」的流式执行层：本机网关 `/v1/chat/completions` → 归一化 SSE 事件。
//
// 为什么不复用 webui-chat-routes 的 api-proxy：那条链路是「会话」语义——建 run、写
// chat-store、发 session 事件、参与 detached 恢复。翻译是一次性动作，没有会话、没有历史，
// 走那条链会在聊天列表里留下一堆「翻译」会话，并且让每个悬浮窗都占一个 run。
//
// 这里只做三件事：
//   1. 把页面/悬浮窗的请求变成一次 OpenAI Chat 请求（流式，带 keepalive 需要的头）；
//   2. 把上游 SSE 增量解析成 `start / delta / done / error` 四种事件；
//   3. 把上游失败按既有口径转成可读中文（humanizeUpstreamError），并在首字节前失败时
//      把「真实原因」交给调用方决定要不要换模型重试。
//
// 网关地址永远是本机回环 + 当前 server 的 client key（与 chat 的 api-proxy 同一取法），
// 不经过任何外部端点；账号由网关按模型 id / X-Provider 正常路由与熔断。

const { fetchWithTimeout } = require('./http-utils');
const { DEFAULT_SERVER_PORT } = require('./server-defaults');
const { humanizeUpstreamError } = require('./webui-chat-routes-utils');

// 首字节预算与整体空转预算分开：思考型模型（长 reasoning）首字节可能很久，但一旦开始
// 输出，静默超过这个时间就说明上游卡住了，必须让用户看到失败而不是无限转圈。
const TRANSLATION_FIRST_BYTE_TIMEOUT_MS = 120 * 1000;
const TRANSLATION_IDLE_TIMEOUT_MS = 90 * 1000;
const TRANSLATION_BODY_BYTES = 256 * 1024;

function normalizeModel(value) {
  return String(value || '').trim();
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function buildGatewayUrl(options = {}) {
  const port = Number(options.port) > 0 ? Number(options.port) : DEFAULT_SERVER_PORT;
  return `http://127.0.0.1:${port}/v1/chat/completions`;
}

function buildGatewayHeaders(options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${options.clientKey || 'dummy'}`
  };
  const provider = normalizeProvider(options.provider);
  if (provider) headers['X-Provider'] = provider;
  // 会话亲和走请求头，不写进 body：body 的 metadata 会被部分上游原样转发
  // （Anthropic 只接受 metadata.user_id），头部则由网关自己消费、不会泄漏给上游。
  const sessionKey = String(options.sessionKey || '').trim();
  if (sessionKey) headers['X-Session-Id'] = sessionKey;
  return headers;
}

function buildGatewayPayload(input = {}) {
  const provider = normalizeProvider(input.provider);
  const request = {
    model: normalizeModel(input.model),
    messages: Array.isArray(input.messages) ? input.messages : [],
    stream: true
  };
  // 翻译是确定性任务：低温 + 不截断输出（译文长度可能超过原文）。
  request.temperature = 0;
  // 会话亲和键由 buildGatewayHeaders 写进 X-Session-Id：code-assist 账号的首次请求
  // 要初始化上游会话，不粘会把每次翻译都轮换到冷账号（实测 1.2–9s 的长尾）。
  // 启动预热使用同一个键，因此能和真实翻译落在同一个账号上。
  // 不要推理预算：code-assist 后端（agy/gemini）默认会注入「无限思考」，
  // 一次 hello world 翻译也会先思考数秒；显式 none 让请求构造层省略 thinkingConfig。
  // 对不支持该字段的 OpenAI 兼容上游它是标准可选字段，会被忽略。
  request.reasoning_effort = 'none';
  if (input.maxTokens != null && Number(input.maxTokens) > 0) {
    request.max_tokens = Math.floor(Number(input.maxTokens));
  }
  // provider 已通过 X-Provider 头显式钉住，模型 id 必须保持原样。
  // 网关不会剥离 `provider/model` 前缀：它会把 `agy/gemini-3.8-flash-low` 当成字面模型 id
  // 去账号目录里匹配，结论是「没有 agy 账号能服务这个模型」，而裸 `gemini-3.8-flash-low`
  // 配合 X-Provider 才是 chat 路径一直在用的形状。
  return request;
}

function parseErrorPayload(rawText, options = {}) {
  const message = humanizeUpstreamError(rawText, {
    status: options.status,
    model: options.model,
    provider: options.provider
  });
  return message || `HTTP ${options.status || 500}`;
}

/**
 * 读取 OpenAI Chat SSE 流，逐块产出事件。
 *
 * @param {ReadableStream} body
 * @param {(event: object) => void} emit
 * @param {{ idleMs?: number }} [options] idleMs：两次块之间允许的最长静默（0/缺省 = 不设）
 * @returns {Promise<{ text: string, usage: object|null, finishReason: string }>}
 */
async function pumpChatStream(body, emit, options = {}) {
  const reader = body && typeof body.getReader === 'function' ? body.getReader() : null;
  if (!reader) throw new Error('translation_stream_unavailable');
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  let finishReason = '';

  const handleBlock = (rawBlock) => {
    const payloadText = String(rawBlock || '')
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!payloadText || payloadText === '[DONE]') return;
    let parsed = null;
    try { parsed = JSON.parse(payloadText); } catch (_error) { return; }
    if (parsed && parsed.error) {
      throw new Error(parseErrorPayload(JSON.stringify(parsed), {}));
    }
    if (parsed && parsed.usage && typeof parsed.usage === 'object') usage = parsed.usage;
    const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    const delta = choice && choice.delta && typeof choice.delta === 'object' ? choice.delta : null;
    const piece = delta && typeof delta.content === 'string' ? delta.content : '';
    if (choice && typeof choice.finish_reason === 'string' && choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
    if (piece) {
      text += piece;
      emit({ type: 'delta', content: piece });
    }
  };

  const idleMs = Number(options.idleMs) > 0 ? Number(options.idleMs) : 0;
  while (true) {
    let timer = null;
    let idleTimedOut = false;
    const readPromise = reader.read();
    const chunk = idleMs > 0
      ? await Promise.race([
        readPromise,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => {
            idleTimedOut = true;
            // 先取消底层流再抛错：只 reject 会让 reader 永远挂着一个未完成的 read。
            try { reader.cancel(); } catch (_error) {}
            reject(new Error('translation_stream_idle_timeout'));
          }, idleMs);
        })
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      })
      : await readPromise;
    if (idleTimedOut) {
      // 已经吐出的增量不做善后：调用方据 error 事件让用户重试；
      // 这里的错误对象带上部分文本，便于上层记录「截断到哪」。
      const error = new Error('translation_stream_idle_timeout');
      error.partialText = text;
      throw error;
    }
    const { value, done } = chunk;
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const rawBlock = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (rawBlock) handleBlock(rawBlock);
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  if (buffer.trim()) handleBlock(buffer.trim());
  return { text, usage, finishReason };
}

/**
 * 执行一次翻译（流式）。所有错误都以 { ok:false } 返回，不抛给路由层，
 * 便于调用方在首字节前换一条路由再试。
 *
 * @param {object} input               请求输入（model/provider/messages/...）
 * @param {object} options             { port, clientKey, timeoutMs }
 * @param {(event:object)=>void} emit  事件回调（delta / done 由本函数发，start 由调用方发）
 * @returns {Promise<{ ok:boolean, text:string, usage:object|null, error?:object }>}
 */
async function runTranslationStream(input, options = {}, emit = () => {}) {
  const payload = buildGatewayPayload(input);
  if (!payload.model) {
    return { ok: false, text: '', usage: null, error: { code: 'translation_model_required', message: '未选择翻译模型' } };
  }
  let response = null;
  try {
    response = await fetchWithTimeout(buildGatewayUrl(options), {
      method: 'POST',
      headers: buildGatewayHeaders({
        ...options,
        provider: input.provider,
        sessionKey: input.sessionKey
      }),
      body: JSON.stringify(payload)
    }, Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : TRANSLATION_FIRST_BYTE_TIMEOUT_MS);
  } catch (error) {
    const timedOut = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    return {
      ok: false,
      text: '',
      usage: null,
      error: {
        code: timedOut ? 'translation_upstream_timeout' : 'translation_upstream_unreachable',
        message: timedOut ? '翻译上游响应超时' : '本机网关请求失败'
      }
    };
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    return {
      ok: false,
      text: '',
      usage: null,
      error: {
        code: 'translation_upstream_error',
        status: response.status,
        message: parseErrorPayload(raw, {
          status: response.status,
          model: payload.model,
          provider: input.provider
        })
      }
    };
  }

  const contentType = String(response.headers && response.headers.get('content-type') || '').toLowerCase();
  // 上游没按流返回（少数通道会聚合）：读成一次性 JSON，仍然按 delta 交付，语义不变。
  if (!contentType.includes('text/event-stream')) {
    let data = null;
    try { data = await response.json(); } catch (_error) { data = null; }
    const text = String(
      data && data.choices && data.choices[0] && data.choices[0].message
      && (data.choices[0].message.content || '')
      || ''
    );
    if (!text) {
      return {
        ok: false,
        text: '',
        usage: null,
        error: { code: 'translation_empty_output', message: '上游没有返回译文' }
      };
    }
    emit({ type: 'delta', content: text });
    return { ok: true, text, usage: data && data.usage || null };
  }

  try {
    const result = await pumpChatStream(response.body, emit, {
      idleMs: Number(options.idleTimeoutMs) > 0 ? Number(options.idleTimeoutMs) : TRANSLATION_IDLE_TIMEOUT_MS
    });
    return { ok: true, text: result.text, usage: result.usage, finishReason: result.finishReason };
  } catch (error) {
    return {
      ok: false,
      text: String(error && error.partialText || ''),
      usage: null,
      error: {
        code: String(error && error.message || '') === 'translation_stream_idle_timeout'
          ? 'translation_stream_idle_timeout'
          : 'translation_stream_failed',
        message: String(error && error.message || '') === 'translation_stream_idle_timeout'
          ? '翻译上游长时间没有新内容，已中断'
          : String(error && error.message || '翻译流中断')
      }
    };
  }
}

module.exports = {
  TRANSLATION_FIRST_BYTE_TIMEOUT_MS,
  TRANSLATION_IDLE_TIMEOUT_MS,
  TRANSLATION_BODY_BYTES,
  buildGatewayPayload,
  buildGatewayHeaders,
  buildGatewayUrl,
  pumpChatStream,
  runTranslationStream
};
