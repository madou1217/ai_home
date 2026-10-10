'use strict';

const MAX_FRAME_BYTES = 64 * 1024;
const FAILURE_EVENTS = new Set(['error', 'response.failed']);

// 只识别显式协议错误；正常输出中出现相同文案不会成为账号失败。
function readUpstreamErrorEvent(payload, eventName = '') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const type = FAILURE_EVENTS.has(eventName) ? eventName : payload.type;
  const error = payload.response?.error || payload.error || payload;
  const status = Number(payload.status || payload.status_code || error.status || error.status_code);
  const hasExplicitError = Boolean(
    payload.error
    || payload.response?.error
    || payload.response?.last_error
    || payload.last_error
  );
  // Some OpenAI-compatible relays omit `event: error`/`type`, but still emit a
  // JSON error envelope with an explicit HTTP status. Require both signals so
  // ordinary successful data containing a free-form `error` field is ignored.
  const hasStatusErrorEnvelope = status >= 400 && status <= 599 && hasExplicitError;
  if (!FAILURE_EVENTS.has(type) && !hasStatusErrorEnvelope) return null;
  return {
    statusCode: status >= 400 && status <= 599 ? status : 0,
    body: { ...payload, type },
    detail: typeof error === 'string' ? error : error.message || error.code || type
  };
}

// 旁路观察器不改变转发字节。逐行拼接原始 Buffer，兼容 UTF-8/CRLF 跨 chunk；
// 超大帧丢弃到下一个空行，随后继续识别，缓存始终受限。
function createUpstreamErrorStreamObserver(onFailure) {
  let lineParts = [];
  let lineBytes = 0;
  let frameBytes = 0;
  let dataLines = [];
  let eventName = '';
  let discardFrame = false;
  let skipLf = false;
  let failed = false;

  const appendLine = (part) => {
    lineBytes += part.length;
    frameBytes += part.length;
    if (frameBytes > MAX_FRAME_BYTES) {
      discardFrame = true;
      lineParts = [];
      dataLines = [];
    } else if (!discardFrame && part.length) {
      lineParts.push(part);
    }
  };

  const finishLine = () => {
    if (!lineBytes) {
      if (!discardFrame && dataLines.length) {
        let payload;
        try { payload = JSON.parse(dataLines.join('\n')); } catch (_error) { /* non-JSON SSE */ }
        const failure = readUpstreamErrorEvent(payload, eventName);
        if (failure) {
          failed = true;
          onFailure(failure);
        }
      }
      frameBytes = 0;
      dataLines = [];
      eventName = '';
      discardFrame = false;
    } else if (!discardFrame) {
      const line = Buffer.concat(lineParts, lineBytes).toString('utf8');
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      if (field === 'data') dataLines.push(value);
    }
    lineParts = [];
    lineBytes = 0;
  };

  return {
    append(chunk) {
      if (failed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < buffer.length && !failed) {
        if (skipLf) {
          skipLf = false;
          if (buffer[offset] === 10) { offset++; continue; }
        }
        const lf = buffer.indexOf(10, offset);
        const cr = buffer.indexOf(13, offset);
        const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
        if (end < 0) { appendLine(buffer.subarray(offset)); break; }
        appendLine(buffer.subarray(offset, end));
        frameBytes++;
        if (frameBytes > MAX_FRAME_BYTES) discardFrame = true;
        skipLf = buffer[end] === 13;
        finishLine();
        offset = end + 1;
      }
    }
  };
}

module.exports = { createUpstreamErrorStreamObserver, readUpstreamErrorEvent };
