'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseGrokBillingGrpcResponse } = require('../lib/cli/services/usage/grok-billing-grpc');

const NOW = Date.parse('2026-10-07T00:00:00Z');

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  while (remaining >= 128n) {
    bytes.push(Number(remaining & 127n) | 128);
    remaining >>= 7n;
  }
  return Buffer.from([...bytes, Number(remaining)]);
}

function message(number, bytes) {
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

function scalar(number, value) {
  return Buffer.concat([varint(number * 8), varint(value)]);
}

function percent(value) {
  const bytes = Buffer.alloc(5);
  bytes[0] = 13;
  bytes.writeFloatLE(value, 1);
  return bytes;
}

function billing(options = {}) {
  const period = Buffer.concat([
    scalar(1, options.type ?? 2),
    message(2, scalar(1, (options.start ?? NOW - 6 * 86400_000) / 1000)),
    message(3, scalar(1, (options.end ?? NOW + 86400_000) / 1000))
  ]);
  const config = Buffer.concat([
    ...(Object.hasOwn(options, 'usedPct') ? [percent(options.usedPct)] : []),
    ...(options.period === false ? [] : [message(8, period)]),
    options.extra || Buffer.alloc(0)
  ]);
  return message(1, config);
}

function frame(bytes, flag = 0) {
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

test('Grok gRPC billing decodes framed and raw explicit percentages without borrowing wallet amounts', () => {
  const payload = billing({ usedPct: 37.5 });
  const expected = { remainingPct: 62.5, resetAtMs: NOW + 86400_000, windowMinutes: 10080 };
  assert.deepEqual(parseGrokBillingGrpcResponse(payload, NOW), expected);
  assert.deepEqual(parseGrokBillingGrpcResponse(Buffer.concat([
    frame(payload), frame(Buffer.from('grpc-status:0\r\n'), 0x80)
  ]), NOW), expected);
  assert.equal(parseGrokBillingGrpcResponse(billing({ usedPct: 150 }), NOW).remainingPct, 0);
});

test('Grok proto3 omitted percentage means zero usage only inside a complete active known period', () => {
  assert.equal(parseGrokBillingGrpcResponse(billing(), NOW).remainingPct, 100);
  for (const options of [
    { period: false }, { type: 0 }, { start: NOW + 1000 }, { end: NOW },
    { start: NOW + 86400_000, end: NOW - 86400_000 },
    { extra: message(7, percent(1)) }
  ]) assert.equal(parseGrokBillingGrpcResponse(billing(options), NOW), null, JSON.stringify(options));
});

test('unknown opaque bytes cannot invent percentages or invalidate a complete Grok period', () => {
  const opaque = message(100, Buffer.from([13, 0, 0, 200, 66, 255]));
  assert.equal(parseGrokBillingGrpcResponse(billing({ extra: opaque }), NOW).remainingPct, 100);
});

test('Grok gRPC rejects error trailers, malformed frames, duplicate quota fields and invalid protobuf', () => {
  const payload = billing();
  for (const bytes of [
    Buffer.concat([frame(payload), frame(Buffer.from('grpc-status:16\r\n'), 0x80)]),
    Buffer.concat([frame(payload), frame(payload)]),
    frame(payload, 1), frame(payload).subarray(0, 10), Buffer.alloc(65537),
    Buffer.concat([payload, Buffer.from([0])]),
    billing({ extra: message(5, Buffer.from([8, 128])) }),
    billing({ usedPct: NaN }), billing({ usedPct: -1 }),
    billing({ usedPct: 0, extra: percent(1) }),
    billing({ extra: Buffer.from([128, 128, 128, 128, 128, 128, 128, 128, 128, 2]) })
  ]) assert.equal(parseGrokBillingGrpcResponse(bytes, NOW), null);
});
