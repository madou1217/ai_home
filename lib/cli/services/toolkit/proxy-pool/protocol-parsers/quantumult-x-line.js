'use strict';

// Quantumult X 的 [server_local] 行：`类型=服务器:端口, key=value, …, tag=名字`。

const { formatServerHost, normalizeServerHost } = require('./base-parser');
const { sanitizeSurgeName, splitTopLevel, unquote } = require('./surge-line');

/** → { type, server, port, params, name }；不是节点行时返回 null。 */
function parseQuantumultXLine(line) {
  const text = String(line || '').trim();
  if (!text || text.startsWith('#') || text.startsWith(';') || text.startsWith('//')) return null;
  const [head, ...rest] = splitTopLevel(text);
  const match = String(head || '').match(/^([A-Za-z0-9-]+)\s*=\s*(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/);
  if (!match) return null;
  const params = {};
  for (const token of rest) {
    const separator = token.indexOf('=');
    if (separator <= 0) continue;
    params[token.slice(0, separator).trim().toLowerCase()] = unquote(token.slice(separator + 1));
  }
  return {
    type: match[1].toLowerCase(),
    server: normalizeServerHost(match[2]),
    port: Number(match[3]),
    params,
    name: params.tag || ''
  };
}

/** { type, server, port, params } → 一行；空参数省略，tag 放最后。 */
function formatQuantumultXLine(name, { type, server, port, params = {} }) {
  const parts = [`${type}=${formatServerHost(server)}:${port}`];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${key}=${value}`);
  }
  parts.push(`tag=${sanitizeSurgeName(name)}`);
  return parts.join(', ');
}

module.exports = {
  formatQuantumultXLine,
  parseQuantumultXLine
};
