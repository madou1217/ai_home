'use strict';

// 流内错误（首字节之后的上游失败）的 canonical 语义：`{ type: 'stream_error', code, message, statusCode }`。
//
// 为什么需要它：此前 canonical 事件流只有「成功终止」（message_stop），parser 在 EOF 时会
// 补一个 message_stop(stop)，于是任何中途失败到了客户端都变成一次「干净的 end_turn」——
// Claude Code 认为这一轮正常结束、不重试，用户看到的就是「回答莫名中断」。
//
// 本模块是两张表（Table + Strategy）：
//   * STREAM_ERROR_READERS：各源协议的错误帧 → canonical stream_error；
//   * STREAM_ERROR_RENDERERS：canonical stream_error → 各客户端协议的**原生**错误事件
//     （Anthropic `event: error`、Responses `response.failed`、Chat/Gemini 的 error 数据帧）。
// 新增协议 = 各加一行，parser/renderer 不需要知道别的协议长什么样。

function toText(value) {
  return value == null ? '' : String(value);
}

function normalizeStatus(value, fallback = 502) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback;
}

/** 任意错误对象 → canonical stream_error。 */
function toStreamErrorEvent(raw = {}, fallbackStatus = 502) {
  const source = raw && typeof raw === 'object' ? raw : { message: toText(raw) };
  return {
    type: 'stream_error',
    code: toText(source.code || source.type || 'upstream_stream_error').trim() || 'upstream_stream_error',
    message: toText(source.message || source.detail || 'upstream stream failed').trim() || 'upstream stream failed',
    statusCode: normalizeStatus(source.status || source.statusCode || source.code, fallbackStatus)
  };
}

const STATUS_BY_ANTHROPIC_TYPE = Object.freeze({
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529
});

const STREAM_ERROR_READERS = Object.freeze({
  // OpenAI 兼容约定：`data: {"error":{...}}`（没有 choices）。
  openai_chat(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data.choices)) return null;
    if (!data.error || typeof data.error !== 'object') return null;
    return toStreamErrorEvent(data.error);
  },
  anthropic_messages(data, eventName) {
    if (!data || (eventName !== 'error' && data.type !== 'error')) return null;
    const error = data.error && typeof data.error === 'object' ? data.error : {};
    return toStreamErrorEvent({
      code: error.type,
      message: error.message,
      status: STATUS_BY_ANTHROPIC_TYPE[error.type]
    });
  },
  openai_responses(data, eventName) {
    const type = toText((data && data.type) || eventName).trim();
    if (type === 'response.failed') {
      const error = (data.response && data.response.error) || {};
      return toStreamErrorEvent({ code: error.code, message: error.message });
    }
    if (type === 'error') return toStreamErrorEvent(data.error || data);
    return null;
  }
});

function readStreamError(sourceProtocol, data, eventName = '') {
  const reader = STREAM_ERROR_READERS[sourceProtocol];
  return reader ? reader(data, eventName) : null;
}

/** canonical stream_error → Anthropic 错误类型（Claude Code 对 overloaded / rate_limit 会自动重试）。 */
function resolveAnthropicErrorType(event) {
  const status = Number(event && event.statusCode);
  if (/context_length|prompt is too long/i.test(`${event.code} ${event.message}`)) return 'invalid_request_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 400 || status === 413 || status === 422) return 'invalid_request_error';
  if (status === 503 || status === 529 || status === 504) return 'overloaded_error';
  return 'api_error';
}

function resolveOpenAIErrorType(event) {
  const status = Number(event && event.statusCode);
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

const GEMINI_STATUS_NAMES = Object.freeze({
  400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND',
  429: 'RESOURCE_EXHAUSTED', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED'
});

function writeSseJson(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

const STREAM_ERROR_RENDERERS = Object.freeze({
  anthropic_messages(event) {
    return writeSseJson('error', {
      type: 'error',
      error: { type: resolveAnthropicErrorType(event), message: event.message }
    });
  },
  openai_chat(event) {
    return writeData({
      error: { message: event.message, type: resolveOpenAIErrorType(event), code: event.code, param: null }
    });
  },
  openai_responses(event, context = {}) {
    return writeSseJson('response.failed', {
      type: 'response.failed',
      response: {
        ...(context.responseBase || {}),
        status: 'failed',
        error: { code: event.code, message: event.message }
      }
    });
  },
  gemini_generate_content(event) {
    return writeData({
      error: { code: event.statusCode, message: event.message, status: GEMINI_STATUS_NAMES[event.statusCode] || 'INTERNAL' }
    });
  }
});

function renderStreamError(targetProtocol, event, context) {
  const key = targetProtocol === 'gemini_stream_generate_content' ? 'gemini_generate_content' : targetProtocol;
  const render = STREAM_ERROR_RENDERERS[key];
  return render ? render(event, context) : '';
}

module.exports = {
  readStreamError,
  renderStreamError,
  resolveAnthropicErrorType,
  toStreamErrorEvent
};
