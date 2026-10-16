const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createKiroEventStreamParser,
  decodeKiroEventStream,
  decodeKiroEventStreamFrame
} = require('../lib/server/kiro-event-stream');
const { encodeKiroEventStreamFrame: encodeFrame } = require('./helpers/kiro-event-stream-encoder');

test('decodeKiroEventStreamFrame reads event headers and payload', () => {
  const frame = encodeFrame(
    { ':message-type': 'event', ':event-type': 'assistantResponseEvent', ':content-type': 'application/json' },
    JSON.stringify({ content: '你好', modelId: 'auto' })
  );
  const decoded = decodeKiroEventStreamFrame(frame);
  assert.equal(decoded.messageType, 'event');
  assert.equal(decoded.eventType, 'assistantResponseEvent');
  assert.equal(decoded.exceptionType, '');
  assert.deepEqual(JSON.parse(decoded.payload), { content: '你好', modelId: 'auto' });
});

test('decodeKiroEventStreamFrame rejects a frame whose declared length does not match', () => {
  const frame = encodeFrame({ ':message-type': 'event', ':event-type': 'initial-response' }, '{}');
  assert.throws(() => decodeKiroEventStreamFrame(frame.subarray(0, frame.length - 2)), {
    code: 'kiro_event_stream_frame_length_mismatch'
  });
});

test('createKiroEventStreamParser buffers frames split across chunks', () => {
  const first = encodeFrame({ ':message-type': 'event', ':event-type': 'initial-response' }, '{"conversationId":"c1"}');
  const second = encodeFrame({ ':message-type': 'event', ':event-type': 'assistantResponseEvent' }, '{"content":"a"}');
  const third = encodeFrame({ ':message-type': 'event', ':event-type': 'assistantResponseEvent' }, '{"content":"b"}');
  const all = Buffer.concat([first, second, third]);
  // 每个字节单独喂：一帧都不该丢，也不该早产。
  const parser = createKiroEventStreamParser();
  const frames = [];
  for (const byte of all) {
    frames.push(...parser.push(Buffer.from([byte])));
  }
  assert.equal(frames.length, 3);
  assert.equal(frames[0].eventType, 'initial-response');
  assert.equal(frames[2].payload, '{"content":"b"}');
  assert.equal(parser.pendingBytes, 0);
});

test('createKiroEventStreamParser keeps an incomplete trailing frame pending', () => {
  const complete = encodeFrame({ ':message-type': 'event', ':event-type': 'assistantResponseEvent' }, '{"content":"a"}');
  const partial = encodeFrame({ ':message-type': 'event', ':event-type': 'assistantResponseEvent' }, '{"content":"b"}');
  const parser = createKiroEventStreamParser();
  const frames = parser.push(Buffer.concat([complete, partial.subarray(0, 5)]));
  assert.equal(frames.length, 1);
  assert.equal(parser.pendingBytes, 5);
  const rest = parser.push(partial.subarray(5));
  assert.equal(rest.length, 1);
  assert.equal(parser.pendingBytes, 0);
});

test('createKiroEventStreamParser fails closed on an impossible frame length', () => {
  const bad = Buffer.alloc(16);
  bad.writeUInt32BE(4, 0); // 小于最小帧长
  const parser = createKiroEventStreamParser();
  assert.throws(() => parser.push(bad), { code: 'kiro_event_stream_frame_length_invalid_4' });
});

test('createKiroEventStreamParser rejects unknown header value types instead of misreading', () => {
  const frame = encodeFrame({ ':message-type': 'event', ':event-type': 'x' }, '{}');
  // 把第一个 header 的值类型改成未知类型（10）：值类型字节 = 12B prelude + 1B 名字长度 + 名字
  frame.writeUInt8(10, 12 + 1 + Buffer.byteLength(':message-type'));
  const parser = createKiroEventStreamParser();
  assert.throws(() => parser.push(frame), { code: 'kiro_event_stream_unknown_header_type_10' });
});

test('decodeKiroEventStream reports truncated input', () => {
  const frame = encodeFrame({ ':message-type': 'event', ':event-type': 'assistantResponseEvent' }, '{"content":"a"}');
  // 残帧留在缓冲里（长度声明大于实到字节）→ 整体解码必须报截断，而不是静默丢掉。
  assert.throws(() => decodeKiroEventStream(frame.subarray(0, frame.length - 3)), {
    code: 'kiro_event_stream_truncated'
  });
  assert.deepEqual(decodeKiroEventStream(frame).map((item) => item.eventType), ['assistantResponseEvent']);
});

test('exception frames expose their exception type', () => {
  const frame = encodeFrame(
    { ':message-type': 'exception', ':exception-type': 'ValidationException', ':content-type': 'application/json' },
    JSON.stringify({ message: 'The provided credential is invalid.' })
  );
  const decoded = decodeKiroEventStreamFrame(frame);
  assert.equal(decoded.messageType, 'exception');
  assert.equal(decoded.exceptionType, 'ValidationException');
});
