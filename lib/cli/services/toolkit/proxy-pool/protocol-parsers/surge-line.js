'use strict';

// Surge 系代理行的分词与拼装：`名字 = 类型, 位置参数…, key=value…`（Surge / Surfboard / Loon 通用）。
// 值里有逗号、等号或首尾空白时用双引号包起来；解析时去掉引号。

const OPENERS = Object.freeze({ '[': ']', '{': '}', '(': ')' });
const CLOSERS = new Set([']', '}', ')']);

/**
 * 顶层逗号分词：引号内与括号内（`[…]` / `{…}` / `(…)`）的逗号不算分隔符。
 * Loon 的 WireGuard 写 `peers=[{public-key="…",allowed-ips="0.0.0.0/0,::/0",endpoint=…}]`，
 * Surge 的 peer 写 `(public-key = …, allowed-ips = "…", endpoint = …)`，都靠这个才切得对。
 */
function splitTopLevel(text) {
  const parts = [];
  const stack = [];
  let current = '';
  let quoted = false;
  for (const char of String(text)) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (quoted) {
      current += char;
      continue;
    }
    if (OPENERS[char]) stack.push(OPENERS[char]);
    else if (CLOSERS.has(char) && stack[stack.length - 1] === char) stack.pop();
    if (char === ',' && !stack.length) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

function unquote(value) {
  const text = String(value || '').trim();
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

/** `名字 = 类型, …` → { name, type, args, params }；不是代理行时返回 null。 */
function parseSurgeLine(line) {
  const text = String(line || '').trim();
  if (!text || text.startsWith('#') || text.startsWith(';') || text.startsWith('//')) return null;
  const separator = text.indexOf('=');
  if (separator <= 0) return null;
  const name = unquote(text.slice(0, separator));
  const tokens = splitTopLevel(text.slice(separator + 1));
  const type = unquote(tokens.shift()).toLowerCase();
  if (!name || !type || !/^[a-z0-9-]+$/.test(type)) return null;
  const args = [];
  const params = {};
  for (const token of tokens) {
    const match = token.match(/^([A-Za-z0-9-]+)\s*=\s*([\s\S]*)$/);
    if (match) params[match[1].toLowerCase()] = unquote(match[2]);
    else if (token) args.push(unquote(token));
  }
  return { name, type, args, params };
}

/** 强制加引号的值（Loon 的密码、UUID 等位置参数习惯写成 "…"）。 */
function quoted(value) {
  return { quoted: String(value) };
}

/** 原样值：不加引号、不做转义（Loon 的 `peers=[{…}]` 里已经自带引号与括号）。 */
function raw(value) {
  return { raw: String(value) };
}

function formatSurgeValue(value) {
  if (value && typeof value === 'object' && 'raw' in value) return value.raw;
  if (value && typeof value === 'object' && 'quoted' in value) return `"${value.quoted}"`;
  const text = String(value);
  return /[,=]|^\s|\s$/.test(text) ? `"${text}"` : text;
}

/** 名字里不能出现分隔符（逗号、等号），换成空格并收拢。 */
function sanitizeSurgeName(name) {
  return String(name || '').replace(/[,=]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** { type, args, params } → 一行；undefined / 空串参数省略，布尔写成 true / false。 */
function formatSurgeLine(name, { type, args = [], params = {} }) {
  const parts = [type, ...args.filter((value) => value !== undefined && value !== null && value !== '').map(formatSurgeValue)];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${formatSurgeValue(value)}`);
  }
  return `${name} = ${parts.join(', ')}`;
}

module.exports = {
  formatSurgeLine,
  formatSurgeValue,
  parseSurgeLine,
  quoted,
  raw,
  sanitizeSurgeName,
  splitTopLevel,
  unquote
};
