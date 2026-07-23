'use strict';

const path = require('node:path');

let DatabaseSyncCtor = null;
function getDatabaseSync() {
  if (DatabaseSyncCtor !== null) return DatabaseSyncCtor;
  try { ({ DatabaseSync: DatabaseSyncCtor } = require('node:sqlite')); } catch (_error) { DatabaseSyncCtor = false; }
  return DatabaseSyncCtor || null;
}

function normalizeProjectPath(value) {
  return String(value || '').trim().replace(/^\\\\\?\\/, '');
}

function parseConversation(row) {
  try {
    const value = JSON.parse(String(row.value || ''));
    return { row, value };
  } catch (_error) {
    return null;
  }
}

function readKiroConversations(dbPath) {
  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync || !dbPath) return [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db.prepare('SELECT key, conversation_id, value, created_at, updated_at FROM conversations_v2').all()
      .map(parseConversation)
      .filter(Boolean);
  } catch (_error) {
    return [];
  } finally {
    try { if (db) db.close(); } catch (_error) {}
  }
}

function getPrompt(turn) {
  return String(turn && turn.user && turn.user.content && turn.user.content.Prompt && turn.user.content.Prompt.prompt || '').trim();
}

function getResponse(turn) {
  return String(turn && turn.assistant && turn.assistant.Response && turn.assistant.Response.content || '').trim();
}

function readKiroProjects(dbPath, options = {}) {
  const projectsByPath = new Map();
  for (const conversation of readKiroConversations(dbPath)) {
    const projectPath = normalizeProjectPath(conversation.row.key);
    const id = String(conversation.row.conversation_id || conversation.value.conversation_id || '').trim();
    if (!projectPath || !id) continue;
    const history = Array.isArray(conversation.value.history) ? conversation.value.history : [];
    const firstPrompt = history.map(getPrompt).find(Boolean) || id;
    const session = {
      id,
      title: firstPrompt.slice(0, 80),
      updatedAt: Number(conversation.row.updated_at || conversation.row.created_at) || 0,
      provider: 'kiro',
      projectDirName: projectPath,
      ...(options.accountRef ? { accountRef: options.accountRef } : {})
    };
    const existing = projectsByPath.get(projectPath) || new Map();
    existing.set(id, session);
    projectsByPath.set(projectPath, existing);
  }
  return Array.from(projectsByPath.entries()).map(([projectPath, sessions]) => ({
    id: `kiro-${Buffer.from(projectPath).toString('base64url')}`,
    name: path.basename(projectPath) || projectPath,
    path: projectPath,
    sessions: Array.from(sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt),
    provider: 'kiro',
    ...(options.accountRef ? { accountRef: options.accountRef } : {})
  }));
}

function findConversation(dbPath, sessionId) {
  return readKiroConversations(dbPath).find((item) => String(item.row.conversation_id) === String(sessionId)) || null;
}

function readKiroSessionMessages(dbPath, sessionId) {
  const conversation = findConversation(dbPath, sessionId);
  if (!conversation) return [];
  const messages = [];
  for (const turn of Array.isArray(conversation.value.history) ? conversation.value.history : []) {
    const model = String(turn && turn.request_metadata && turn.request_metadata.model_id || conversation.value.model_info && conversation.value.model_info.model_id || '').trim() || undefined;
    const prompt = getPrompt(turn);
    const response = getResponse(turn);
    if (prompt) messages.push({ role: 'user', content: prompt, model });
    if (response) messages.push({ role: 'assistant', content: response, model });
  }
  return messages;
}

function readKiroSessionModel(dbPath, sessionId) {
  const conversation = findConversation(dbPath, sessionId);
  if (!conversation) return '';
  const history = Array.isArray(conversation.value.history) ? conversation.value.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const model = String(history[index] && history[index].request_metadata && history[index].request_metadata.model_id || '').trim();
    if (model) return model;
  }
  return String(conversation.value.model_info && conversation.value.model_info.model_id || '').trim();
}

module.exports = { readKiroProjects, readKiroSessionMessages, readKiroSessionModel };
