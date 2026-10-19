'use strict';

// 测试专用的 AWS event-stream **编码器**：生产代码只解不编（`lib/server/kiro-event-stream.js`），
// 因此编码器留在测试侧，供 kiro 帧解析与 transport 两个测试共用，避免各写一份。

function encodeHeader(name, value) {
  const nameBuffer = Buffer.from(name, 'utf8');
  const valueBuffer = Buffer.from(String(value), 'utf8');
  const header = Buffer.alloc(1 + nameBuffer.length + 1 + 2 + valueBuffer.length);
  header.writeUInt8(nameBuffer.length, 0);
  nameBuffer.copy(header, 1);
  header.writeUInt8(7, 1 + nameBuffer.length); // 7 = string
  header.writeUInt16BE(valueBuffer.length, 2 + nameBuffer.length);
  valueBuffer.copy(header, 4 + nameBuffer.length);
  return header;
}

function encodeKiroEventStreamFrame(headers, payload) {
  const headersBuffer = Buffer.concat(
    Object.entries(headers || {}).map(([name, value]) => encodeHeader(name, value))
  );
  const payloadBuffer = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  const totalLength = 12 + headersBuffer.length + payloadBuffer.length + 4;
  const frame = Buffer.alloc(totalLength);
  frame.writeUInt32BE(totalLength, 0);
  frame.writeUInt32BE(headersBuffer.length, 4);
  frame.writeUInt32BE(0, 8); // prelude CRC（解码侧不校验）
  headersBuffer.copy(frame, 12);
  payloadBuffer.copy(frame, 12 + headersBuffer.length);
  frame.writeUInt32BE(0, totalLength - 4); // message CRC
  return frame;
}

function encodeKiroAssistantEvent(content) {
  return encodeKiroEventStreamFrame(
    { ':message-type': 'event', ':event-type': 'assistantResponseEvent', ':content-type': 'application/json' },
    { content, modelId: 'auto' }
  );
}

function encodeKiroInitialResponse(conversationId) {
  return encodeKiroEventStreamFrame(
    { ':message-type': 'event', ':event-type': 'initial-response', ':content-type': 'application/x-amz-json-1.0' },
    { conversationId }
  );
}

function encodeKiroEvent(eventType, payload) {
  return encodeKiroEventStreamFrame(
    { ':message-type': 'event', ':event-type': eventType, ':content-type': 'application/json' },
    payload
  );
}

/** 真机形状：首帧只有 name，随后 input 字符串分片，最后 stop:true。 */
function encodeKiroToolUseEvents(toolUseId, name, inputChunks = []) {
  return [
    encodeKiroEvent('toolUseEvent', { name, toolUseId }),
    ...inputChunks.map((input) => encodeKiroEvent('toolUseEvent', { input, name, toolUseId })),
    encodeKiroEvent('toolUseEvent', { name, stop: true, toolUseId })
  ];
}

module.exports = {
  encodeKiroEventStreamFrame,
  encodeKiroAssistantEvent,
  encodeKiroInitialResponse,
  encodeKiroEvent,
  encodeKiroToolUseEvents
};
