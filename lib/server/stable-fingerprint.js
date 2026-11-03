'use strict';

// 参数的**稳定指纹**：同一个选择必须得到同一个键，顺序不同不算不同选择。
//
// 为什么不用 JSON.stringify：对象键顺序、数组元素顺序都会影响结果，于是
// 「账号 A,B」与「B,A」会被当成两次不同的运行 —— 防抖失效，同一批账号被领两次。
// 这里把对象键排序、数组元素按稳定序列化排序，再在超长时压成 sha256 前缀，
// 保证键既可比又不会长到撑爆日志/状态文件。
//
// 数组排序是**刻意的**：今天所有数组参数（account-refs）语义都与顺序无关。
// 将来若出现有序参数（例如优先级列表），要给它单独的 type，而不是复用这里的语义。

const crypto = require('node:crypto');

const MAX_FINGERPRINT_LENGTH = 192;

function stableSerialize(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).sort().join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/**
 * @param {object} [params]
 * @returns {string} 空参数返回空串（调用方据此保持「裸 id」的键不变）
 */
function stableFingerprint(params) {
  if (!params || typeof params !== 'object') return '';
  if (Object.keys(params).length === 0) return '';
  const serialized = stableSerialize(params);
  if (serialized.length <= MAX_FINGERPRINT_LENGTH) return serialized;
  return `sha256:${crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 16)}`;
}

module.exports = {
  MAX_FINGERPRINT_LENGTH,
  stableSerialize,
  stableFingerprint
};
