'use strict';

// SSH 剪贴板桥的运行模式：终端能力（terminal）、回退 agent（agent）、agent 端点（endpoint）。
// endpoint 形如 `unix:/path`（本机 socket）或 URL。
const CLIPBOARD_CONTEXT_ENV = 'AIH_SSH_CLIPBOARD';
const FIELD_ORDER = Object.freeze(['terminal', 'agent', 'endpoint']);

function parseClipboardContext(value) {
  const fields = {};
  for (const part of String(value || '').split(',')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!key || !raw) continue;
    try { fields[key] = decodeURIComponent(raw); } catch (_error) { fields[key] = raw; }
  }
  return fields;
}

function serializeClipboardContext(fields = {}) {
  return FIELD_ORDER
    .filter((key) => fields[key] !== undefined && fields[key] !== null && String(fields[key]) !== '')
    .map((key) => `${key}=${encodeURIComponent(String(fields[key]))}`)
    .join(',');
}

function readClipboardField(env, key, fallback = '') {
  const fields = parseClipboardContext(env && env[CLIPBOARD_CONTEXT_ENV]);
  return fields[key] === undefined ? fallback : fields[key];
}

module.exports = {
  CLIPBOARD_CONTEXT_ENV,
  parseClipboardContext,
  serializeClipboardContext,
  readClipboardField
};
