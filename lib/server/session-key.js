'use strict';

const crypto = require('node:crypto');

function readNestedString(input, pathParts) {
  let cur = input;
  for (let i = 0; i < pathParts.length; i += 1) {
    if (!cur || typeof cur !== 'object') return '';
    cur = cur[pathParts[i]];
  }
  const text = String(cur || '').trim();
  return text;
}

function normalizeSessionToken(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.length <= 128) return text;
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function extractRequestSessionKey(headers, requestJson) {
  const h = headers || {};
  const candidates = [
    h['x-session-id'],
    h['x-conversation-id'],
    h['x-thread-id'],
    h['openai-session-id'],
    readNestedString(requestJson, ['session_id']),
    readNestedString(requestJson, ['session', 'id']),
    readNestedString(requestJson, ['conversation_id']),
    readNestedString(requestJson, ['conversation', 'id']),
    readNestedString(requestJson, ['thread_id']),
    readNestedString(requestJson, ['thread', 'id']),
    readNestedString(requestJson, ['previous_response_id']),
    readNestedString(requestJson, ['response_id']),
    readNestedString(requestJson, ['metadata', 'session_id']),
    readNestedString(requestJson, ['metadata', 'conversation_id']),
    readNestedString(requestJson, ['metadata', 'thread_id'])
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const normalized = normalizeSessionToken(candidates[i]);
    if (normalized) return normalized;
  }
  return '';
}

module.exports = {
  extractRequestSessionKey
};
