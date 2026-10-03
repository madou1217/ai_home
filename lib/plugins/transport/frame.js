'use strict';

// 插件线协议的分帧：12 字节头（4 字节元数据长度 + 8 字节 payload 长度，大端）+ JSON 元数据 + 二进制 payload。
// 大块数据（图片、长文本）走 payload 段，不转成 base64 塞进 JSON。
//
// 这里只校验帧结构；协议版本的协商在握手里做（见 rpc-server），这样版本不兼容的对端
// 能拿到明确的 plugin_rpc_incompatible，而不是连接被静默断开只看到 EOF。

const { TextDecoder } = require('node:util');
const { limits, messageKinds, protocolVersion } = require('../sdk/contract.generated.json');
const { PluginError, requireCondition } = require('../sdk/errors');

const HEADER_BYTES = 12;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const kinds = new Set(messageKinds);

function validateStructure(value) {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), 'plugin_rpc_invalid');
  requireCondition(kinds.has(value.kind), 'plugin_rpc_invalid');
  requireCondition(Number.isSafeInteger(value.protocolVersion) && value.protocolVersion > 0, 'plugin_rpc_invalid');
  requireCondition(typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 128, 'plugin_rpc_invalid');
  return value;
}

// 握手之后的每一帧都必须是已协商的版本。
function validateMessage(value) {
  validateStructure(value);
  requireCondition(value.kind === 'hello' || value.kind === 'hello.result' || value.protocolVersion === protocolVersion,
    'plugin_rpc_incompatible');
  return value;
}

function encodeFrame(message, payload = Buffer.alloc(0)) {
  validateStructure(message);
  requireCondition(Buffer.isBuffer(payload) && payload.length <= limits.payloadBytes, 'plugin_rpc_payload_limit');
  const metadata = Buffer.from(JSON.stringify(message));
  requireCondition(metadata.length > 0 && metadata.length <= limits.metadataBytes, 'plugin_rpc_metadata_limit');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(metadata.length);
  header.writeBigUInt64BE(BigInt(payload.length), 4);
  return Buffer.concat([header, metadata, payload]);
}

// 数据按 socket 块（通常 64 KiB）到达：先把块收集起来，凑够一整帧时只拼接一次。
// 每来一块就 Buffer.concat 整个缓冲会让大帧的拷贝量随帧大小平方增长（1 MiB 帧实测约 6ms）。
class FrameDecoder {
  constructor(onFrame, options = {}) {
    this.onFrame = onFrame;
    this.maxBuffered = Number(options.bufferedBytes || limits.bufferedBytes);
    this.chunks = [];
    this.length = 0;
    this.expected = 0;
  }

  take(size) {
    const joined = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.length);
    const head = joined.subarray(0, size);
    const rest = joined.subarray(size);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return head;
  }

  peekHeader() {
    if (this.chunks[0].length < HEADER_BYTES) {
      const joined = Buffer.concat(this.chunks, this.length);
      this.chunks = [joined];
    }
    return this.chunks[0];
  }

  push(chunk) {
    requireCondition(this.length + chunk.length <= this.maxBuffered, 'plugin_rpc_buffer_limit');
    this.chunks.push(chunk);
    this.length += chunk.length;
    while (this.length >= HEADER_BYTES) {
      if (!this.expected) {
        const header = this.peekHeader();
        const metadataSize = header.readUInt32BE(0);
        const payloadSize = header.readBigUInt64BE(4);
        requireCondition(metadataSize > 0 && metadataSize <= limits.metadataBytes, 'plugin_rpc_metadata_limit');
        requireCondition(payloadSize <= BigInt(limits.payloadBytes), 'plugin_rpc_payload_limit');
        this.expected = HEADER_BYTES + metadataSize + Number(payloadSize);
      }
      if (this.length < this.expected) return;
      const frameBytes = this.take(this.expected);
      this.expected = 0;
      const metadataSize = frameBytes.readUInt32BE(0);
      let message;
      try { message = JSON.parse(utf8.decode(frameBytes.subarray(HEADER_BYTES, HEADER_BYTES + metadataSize))); }
      catch (_error) { throw new PluginError('plugin_rpc_invalid'); }
      validateStructure(message);
      // 独立拷贝 payload：frameBytes 可能与后续帧共享同一块内存。
      const payload = Buffer.from(frameBytes.subarray(HEADER_BYTES + metadataSize));
      this.onFrame({ message, payload });
    }
  }

  end() {
    requireCondition(this.length === 0, 'plugin_rpc_truncated');
  }
}

module.exports = { encodeFrame, FrameDecoder, HEADER_BYTES, validateMessage, validateStructure };
