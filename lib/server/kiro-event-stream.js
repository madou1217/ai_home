'use strict';

// AWS event-stream（`application/vnd.amazon.eventstream`）帧解码器。
//
// 为什么需要它：kiro 的推理通道是 CodeWhisperer 的**流式 RPC**，响应不是 SSE，
// 而是 AWS 的二进制事件流（实测 2026-10-16）：
//
//   POST https://codewhisperer.<region>.amazonaws.com/
//   content-type: application/x-amz-json-1.0            ← Coral 只认这个（application/json 会被
//   x-amz-target: AmazonCodeWhispererStreamingService.     判成 UnknownOperationException）
//                 GenerateAssistantResponse
//   → 200 application/vnd.amazon.eventstream
//
// 帧格式（AWS 官方 spec）：
//   [4B total length][4B headers length][4B prelude CRC]
//   [headers…][payload][4B message CRC]
//   header 项 = [1B name length][name][1B value type][value]
//   值类型：0=true 1=false 2=byte 3=short 4=int 5=long 6=byte[] 7=string 8=timestamp 9=uuid
//
// 实测帧序列：`:message-type=event` + `:event-type=initial-response`（{conversationId}）→
// 多个 `:event-type=assistantResponseEvent`（{content, modelId} 逐块 delta）→ 结束；
// 失败是 `:message-type=exception` + `:exception-type`（如 ValidationException）。
//
// **增量解析是硬要求**：网络分块会把一帧劈开（首包尤其常见），因此解析器自带缓冲，
// `push(chunk)` 只返回本次能凑齐的完整帧。

const PRELUDE_BYTES = 12;
const MESSAGE_CRC_BYTES = 4;
const MIN_FRAME_BYTES = PRELUDE_BYTES + MESSAGE_CRC_BYTES;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

// 值类型 → 读取器（返回 { value, next }）。按 AWS spec 实现；未知类型直接失败，
// 不做猜测（猜错会静默错位，把后续所有帧读花）。
const HEADER_VALUE_READERS = Object.freeze({
  0: () => ({ value: true }),
  1: () => ({ value: false }),
  2: (frame, cursor) => ({ value: frame.readInt8(cursor), next: cursor + 1 }),
  3: (frame, cursor) => ({ value: frame.readInt16BE(cursor), next: cursor + 2 }),
  4: (frame, cursor) => ({ value: frame.readInt32BE(cursor), next: cursor + 4 }),
  5: (frame, cursor) => ({ value: Number(frame.readBigInt64BE(cursor)), next: cursor + 8 }),
  6: (frame, cursor) => {
    const length = frame.readUInt16BE(cursor);
    return { value: frame.subarray(cursor + 2, cursor + 2 + length), next: cursor + 2 + length };
  },
  7: (frame, cursor) => {
    const length = frame.readUInt16BE(cursor);
    return { value: frame.toString('utf8', cursor + 2, cursor + 2 + length), next: cursor + 2 + length };
  },
  8: (frame, cursor) => ({ value: Number(frame.readBigInt64BE(cursor)), next: cursor + 8 }),
  9: (frame, cursor) => ({ value: frame.toString('hex', cursor, cursor + 16), next: cursor + 16 })
});

function frameError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function readHeaders(frame, headersLength) {
  const headers = {};
  let cursor = PRELUDE_BYTES;
  const end = PRELUDE_BYTES + headersLength;
  while (cursor < end) {
    const nameLength = frame.readUInt8(cursor);
    cursor += 1;
    const name = frame.toString('utf8', cursor, cursor + nameLength);
    cursor += nameLength;
    const valueType = frame.readUInt8(cursor);
    cursor += 1;
    const reader = HEADER_VALUE_READERS[valueType];
    if (!reader) throw frameError(`kiro_event_stream_unknown_header_type_${valueType}`);
    const result = reader(frame, cursor);
    cursor = typeof result.next === 'number' ? result.next : cursor;
    headers[name] = result.value;
  }
  return { headers, payloadStart: cursor };
}

/**
 * 解一帧（必须传完整帧：长度 = 前 4 字节声明的 total length）。
 * @returns {{headers: Object, messageType: string, eventType: string, exceptionType: string, payload: string}}
 */
function decodeKiroEventStreamFrame(frame) {
  if (!frame || frame.length < MIN_FRAME_BYTES) throw frameError('kiro_event_stream_frame_too_short');
  const totalLength = frame.readUInt32BE(0);
  if (totalLength !== frame.length) throw frameError('kiro_event_stream_frame_length_mismatch');
  const headersLength = frame.readUInt32BE(4);
  const { headers, payloadStart } = readHeaders(frame, headersLength);
  const payloadEnd = totalLength - MESSAGE_CRC_BYTES;
  if (payloadEnd < payloadStart) throw frameError('kiro_event_stream_frame_payload_invalid');
  return {
    headers,
    messageType: String(headers[':message-type'] || ''),
    eventType: String(headers[':event-type'] || ''),
    exceptionType: String(headers[':exception-type'] || ''),
    payload: frame.toString('utf8', payloadStart, payloadEnd)
  };
}

/**
 * 增量解析器：`push(chunk)` 返回本次凑齐的帧数组；残包留在内部缓冲里。
 * @param {{maxFrameBytes?: number}} [options]
 */
function createKiroEventStreamParser(options = {}) {
  const maxFrameBytes = Math.max(MIN_FRAME_BYTES, Number(options.maxFrameBytes) || DEFAULT_MAX_FRAME_BYTES);
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      if (chunk && chunk.length) {
        const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        pending = pending.length ? Buffer.concat([pending, incoming]) : incoming;
      }
      const frames = [];
      while (pending.length >= MIN_FRAME_BYTES) {
        const totalLength = pending.readUInt32BE(0);
        if (totalLength < MIN_FRAME_BYTES || totalLength > maxFrameBytes) {
          throw frameError(`kiro_event_stream_frame_length_invalid_${totalLength}`);
        }
        if (pending.length < totalLength) break;
        frames.push(decodeKiroEventStreamFrame(pending.subarray(0, totalLength)));
        pending = pending.subarray(totalLength);
      }
      return frames;
    },
    get pendingBytes() {
      return pending.length;
    }
  };
}

/** 一次性解完整缓冲（非流式路径与测试用）。 */
function decodeKiroEventStream(buffer) {
  const parser = createKiroEventStreamParser();
  const frames = parser.push(buffer);
  if (parser.pendingBytes > 0) throw frameError('kiro_event_stream_truncated');
  return frames;
}

module.exports = {
  decodeKiroEventStreamFrame,
  createKiroEventStreamParser,
  decodeKiroEventStream
};
