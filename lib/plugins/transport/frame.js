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

class FrameDecoder {
  constructor(onFrame, options = {}) {
    this.onFrame = onFrame;
    this.maxBuffered = Number(options.bufferedBytes || limits.bufferedBytes);
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    requireCondition(this.buffer.length + chunk.length <= this.maxBuffered, 'plugin_rpc_buffer_limit');
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= HEADER_BYTES) {
      const metadataSize = this.buffer.readUInt32BE(0);
      const payloadSize = this.buffer.readBigUInt64BE(4);
      requireCondition(metadataSize > 0 && metadataSize <= limits.metadataBytes, 'plugin_rpc_metadata_limit');
      requireCondition(payloadSize <= BigInt(limits.payloadBytes), 'plugin_rpc_payload_limit');
      const total = HEADER_BYTES + metadataSize + Number(payloadSize);
      if (this.buffer.length < total) return;
      let message;
      try { message = JSON.parse(utf8.decode(this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + metadataSize))); }
      catch (_error) { throw new PluginError('plugin_rpc_invalid'); }
      validateStructure(message);
      const payload = Buffer.from(this.buffer.subarray(HEADER_BYTES + metadataSize, total));
      this.buffer = this.buffer.subarray(total);
      this.onFrame({ message, payload });
    }
  }

  end() {
    requireCondition(this.buffer.length === 0, 'plugin_rpc_truncated');
  }
}

module.exports = { encodeFrame, FrameDecoder, HEADER_BYTES, validateMessage, validateStructure };
