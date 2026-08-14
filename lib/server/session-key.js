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

function extractRequestProjectMetadata(headers, requestJson) {
  const h = headers || {};
  const candidates = [
    h['x-project-path'],
    h['x-project'],
    h['x-workspace-path'],
    h['x-workspace'],
    h['x-cwd'],
    readNestedString(requestJson, ['project_path']),
    readNestedString(requestJson, ['projectPath']),
    readNestedString(requestJson, ['project', 'path']),
    readNestedString(requestJson, ['cwd']),
    readNestedString(requestJson, ['workspace', 'path']),
    readNestedString(requestJson, ['workspace'])
  ];
  let projectPath = '';
  for (let i = 0; i < candidates.length; i += 1) {
    const text = String(candidates[i] || '').trim();
    if (text) {
      projectPath = text;
      break;
    }
  }
  const dirNameCandidates = [
    h['x-project-dir-name'],
    h['x-project-name'],
    readNestedString(requestJson, ['project_dir_name']),
    readNestedString(requestJson, ['projectDirName']),
    readNestedString(requestJson, ['project', 'name'])
  ];
  let projectDirName = '';
  for (let i = 0; i < dirNameCandidates.length; i += 1) {
    const text = String(dirNameCandidates[i] || '').trim();
    if (text) {
      projectDirName = text;
      break;
    }
  }
  return {
    projectPath,
    projectDirName
  };
}

module.exports = {
  extractRequestSessionKey,
  extractRequestProjectMetadata
};
