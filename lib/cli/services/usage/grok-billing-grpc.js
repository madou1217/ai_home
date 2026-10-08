'use strict';

// 与 CodexBar 的 Grok 账单适配器及 Grok 官方 proto3 descriptor 保持一致：
// https://github.com/steipete/CodexBar/blob/main/Sources/CodexBarCore/Providers/Grok/GrokWebBillingFetcher.swift
// 只解码 schema 声明的消息；未知 bytes 字段不能参与额度推断。
const BILLING_MESSAGES = new Set([
  '1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.12',
  '1.6.1', '1.6.2', '1.6.3', '1.8.2', '1.8.3', '1.6.3.2', '1.6.3.3'
]);
const MAX_RESPONSE_BYTES = 64 * 1024;

function readFields(bytes) {
  let offset = 0;
  const fields = [];
  function readVarint() {
    let value = 0n;
    for (let index = 0; index < 10; index += 1) {
      if (offset >= bytes.length) throw new Error('truncated_varint');
      const byte = bytes[offset++];
      if (index === 9 && byte > 1) throw new Error('overflow_varint');
      value |= BigInt(byte & 0x7f) << BigInt(index * 7);
      if (!(byte & 0x80)) return value;
    }
    throw new Error('overflow_varint');
  }
  while (offset < bytes.length) {
    const tag = readVarint();
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!number || number > 536_870_911) throw new Error('invalid_field');
    const field = { number, wire };
    if (wire === 0) field.value = readVarint();
    else if (wire === 2) {
      const length = readVarint();
      if (length > BigInt(bytes.length - offset)) throw new Error('truncated_message');
      field.bytes = bytes.subarray(offset, offset + Number(length));
      offset += Number(length);
    } else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      if (bytes.length - offset < length) throw new Error('truncated_fixed');
      if (wire === 5) field.value = bytes.readFloatLE(offset);
      offset += length;
    } else throw new Error('invalid_wire');
    fields.push(field);
  }
  return fields;
}

function singleField(fields, number, wire) {
  const matches = fields.filter((field) => field.number === number);
  if (matches.length > 1 || matches[0] && matches[0].wire !== wire) throw new Error('ambiguous_field');
  return matches[0];
}

function extractPayload(bytes) {
  if (bytes[0] !== 0 && bytes[0] !== 0x80) return bytes;
  let payload = null;
  for (let offset = 0; offset < bytes.length;) {
    if (bytes.length - offset < 5) throw new Error('truncated_frame');
    const flag = bytes[offset];
    if (flag !== 0 && flag !== 0x80) throw new Error('unsupported_frame');
    const length = bytes.readUInt32BE(offset + 1);
    const start = offset + 5;
    if (length > bytes.length - start) throw new Error('truncated_frame');
    const frame = bytes.subarray(start, start + length);
    if (flag === 0x80) {
      for (const line of frame.toString('utf8').split(/\r?\n/)) {
        if (/^grpc-status\s*:/i.test(line) && line.split(':').slice(1).join(':').trim() !== '0') {
          throw new Error('grpc_error');
        }
      }
    } else {
      if (payload) throw new Error('multiple_payloads');
      payload = frame;
    }
    offset = start + length;
  }
  if (!payload) throw new Error('missing_payload');
  return payload;
}

function scanKnownMessages(bytes, key, fieldsByPath) {
  const fields = readFields(bytes);
  fieldsByPath.set(key, fields);
  for (const field of fields) {
    const childKey = key ? `${key}.${field.number}` : String(field.number);
    if (field.wire === 2 && BILLING_MESSAGES.has(childKey)) {
      scanKnownMessages(field.bytes, childKey, fieldsByPath);
    }
  }
  return fields;
}

function readTimestamp(fields) {
  if (!fields) return 0;
  const seconds = singleField(fields, 1, 0)?.value;
  const nanos = singleField(fields, 2, 0)?.value || 0n;
  if (seconds == null || seconds <= 0n || seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))
    || nanos > 999_999_999n) return 0;
  return Number(seconds) * 1000 + Number(nanos) / 1e6;
}

function parseGrokBillingGrpcResponse(data, nowMs = Date.now()) {
  try {
    const bytes = Buffer.from(data);
    if (!bytes.length || bytes.length > MAX_RESPONSE_BYTES) return null;
    const fieldsByPath = new Map();
    const root = scanKnownMessages(extractPayload(bytes), '', fieldsByPath);
    if (!singleField(root, 1, 2)) return null;
    const config = fieldsByPath.get('1');
    const percentage = singleField(config, 1, 5);
    const periodField = singleField(config, 8, 2);
    const period = periodField ? fieldsByPath.get('1.8') : [];
    const periodType = singleField(period, 1, 0)?.value;
    singleField(period, 2, 2);
    singleField(period, 3, 2);
    const startAtMs = readTimestamp(fieldsByPath.get('1.8.2'));
    const periodEndAtMs = readTimestamp(fieldsByPath.get('1.8.3'));
    const activePeriod = (periodType === 1n || periodType === 2n)
      && startAtMs > 0 && startAtMs <= nowMs && periodEndAtMs > nowMs;
    const hasFixed32 = [...fieldsByPath.values()].some((fields) => fields.some((field) => field.wire === 5));
    // 仅完整 proto3 响应中的有效当前周期允许缺省 float=0；REST 缺字段不套用这条规则。
    const usedPct = percentage ? percentage.value : activePeriod && !hasFixed32 ? 0 : null;
    if (usedPct == null || !Number.isFinite(usedPct) || usedPct < 0) return null;
    return {
      remainingPct: 100 - Math.min(100, usedPct),
      resetAtMs: periodEndAtMs || readTimestamp(fieldsByPath.get('1.5')),
      windowMinutes: startAtMs > 0 && periodEndAtMs > startAtMs
        ? Math.round((periodEndAtMs - startAtMs) / 60_000) : 0
    };
  } catch (_error) {
    return null;
  }
}

module.exports = { parseGrokBillingGrpcResponse };
