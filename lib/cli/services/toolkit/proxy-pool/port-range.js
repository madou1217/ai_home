'use strict';

const { isValidPort } = require('./proxy-protocol-contract');

// 端口列表 / 端口区间（Hysteria2 端口跳跃等）的规范化。各客户端的写法不同：
// mihomo 用 `1000-2000,3000`、sing-box 用 `1000:2000` 的数组、Surge 用分号分隔，
// 这里统一解析成区间数组，再按目标格式拼回去。规范形是「升序、逗号分隔、区间用 -」。

// 一个节点上能声明的区间上限（防御性上限，正常订阅远小于它）。
const MAX_PORT_RANGES = 64;

function portRangeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseRangeToken(rawToken) {
  const text = String(rawToken || '').trim();
  if (!text) return null;
  const separator = text.includes('-') ? text.indexOf('-') : text.indexOf(':');
  if (separator === -1) {
    const port = Number(text);
    if (!isValidPort(port)) throw portRangeError('invalid_proxy_field_ports');
    return { start: port, end: port };
  }
  const start = Number(text.slice(0, separator).trim());
  const end = Number(text.slice(separator + 1).trim());
  if (!isValidPort(start) || !isValidPort(end) || start > end) {
    throw portRangeError('invalid_proxy_field_ports');
  }
  return { start, end };
}

/** 解析端口列表（字符串、数组或数字）→ 区间数组；格式非法时抛 invalid_proxy_field_ports。 */
function parsePortRanges(value) {
  const tokens = [];
  const collect = (item) => {
    if (item === undefined || item === null || item === '') return;
    if (typeof item !== 'string' && typeof item !== 'number') {
      throw portRangeError('invalid_proxy_field_ports');
    }
    // 去掉区间分隔符两侧的空格后再切分，`1000 - 2000` 与 `1000-2000` 等价。
    const text = String(item).replace(/\s*([-:])\s*/g, '$1');
    tokens.push(...text.split(/[,;\s]+/));
  };
  if (Array.isArray(value)) value.forEach(collect);
  else collect(value);

  const ranges = tokens.map(parseRangeToken).filter(Boolean);
  if (ranges.length > MAX_PORT_RANGES) throw portRangeError('invalid_proxy_field_ports');
  return ranges;
}

/** 规范形：升序、逗号分隔、区间用 `-`（如 `1000-2000,3000`）；空值返回 undefined。 */
function normalizePortRanges(value) {
  const ranges = parsePortRanges(value);
  if (ranges.length === 0) return undefined;
  const parts = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const text = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
    if (parts[parts.length - 1] !== text) parts.push(text);
  }
  return parts.join(',');
}

/**
 * 规范形按目标格式重新拼装（sing-box 的区间用 `:`、Surge 的列表用 `;`）。
 * alwaysRange 用于 sing-box：它的 server_ports 每一项都必须是 `起:止`，单个端口也要写成 `3000:3000`。
 */
function formatPortRanges(value, options = {}) {
  const canonical = normalizePortRanges(value);
  if (!canonical) return undefined;
  const separator = options.separator || ',';
  const rangeSeparator = options.rangeSeparator || '-';
  const alwaysRange = options.alwaysRange === true;
  return canonical
    .split(',')
    .map((part) => {
      const dash = part.indexOf('-');
      const start = dash === -1 ? part : part.slice(0, dash);
      const end = dash === -1 ? (alwaysRange ? part : undefined) : part.slice(dash + 1);
      if (end === undefined) return start;
      return rangeSeparator === '-' ? `${start}-${end}` : `${start}${rangeSeparator}${end}`;
    })
    .join(separator);
}

/** 区间列表里的第一个（最小）端口：链接或配置只给了端口列表时，用它补上 port。 */
function firstPortOf(value) {
  const ranges = parsePortRanges(value);
  return ranges.length > 0 ? Math.min(...ranges.map((range) => range.start)) : undefined;
}

module.exports = {
  MAX_PORT_RANGES,
  firstPortOf,
  formatPortRanges,
  normalizePortRanges,
  parsePortRanges,
  portRangeError
};
