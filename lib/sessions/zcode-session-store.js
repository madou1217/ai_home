'use strict';

// ZCode 原生运行时把主会话保存在宿主 `~/.zcode/cli/db/db.sqlite`（关系表
// session / message / part，data 列为 JSON）。subagent 会话带
// task_type='subagent_child' 且 parent_id 非空，默认隐藏。
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

function openZcodeDatabase(dbPath) {
  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync || !dbPath) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (_error) {
    return null;
  }
}

function readZcodeSessions(dbPath) {
  const db = openZcodeDatabase(dbPath);
  if (!db) return [];
  try {
    return db.prepare(
      'SELECT id, parent_id, directory, path, title, time_created, time_updated, task_type'
      + ' FROM session ORDER BY time_updated DESC'
    ).all();
  } catch (_error) {
    return [];
  } finally {
    try { db.close(); } catch (_error) {}
  }
}

function readZcodeProjects(dbPath, options = {}) {
  const projectsByPath = new Map();
  for (const row of readZcodeSessions(dbPath)) {
    if (String(row.parent_id || '').trim()) continue;
    const id = String(row.id || '').trim();
    const projectPath = normalizeProjectPath(row.directory || row.path);
    if (!id || !projectPath) continue;
    const session = {
      id,
      title: String(row.title || '').trim().slice(0, 80) || id,
      updatedAt: Number(row.time_updated || row.time_created) || 0,
      createdAt: Number(row.time_created) || 0,
      provider: 'zcode',
      projectDirName: projectPath,
      ...(options.accountRef ? { accountRef: options.accountRef } : {})
    };
    const existing = projectsByPath.get(projectPath) || new Map();
    existing.set(id, session);
    projectsByPath.set(projectPath, existing);
  }
  return Array.from(projectsByPath.entries()).map(([projectPath, sessions]) => ({
    id: `zcode-${Buffer.from(projectPath).toString('base64url')}`,
    name: path.basename(projectPath) || projectPath,
    path: projectPath,
    sessions: Array.from(sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt),
    provider: 'zcode',
    ...(options.accountRef ? { accountRef: options.accountRef } : {})
  }));
}

function readZcodeMessageRows(dbPath, sessionId) {
  const db = openZcodeDatabase(dbPath);
  if (!db) return [];
  try {
    const messages = db.prepare(
      'SELECT id, time_created, sequence, data FROM message WHERE session_id = ? ORDER BY sequence'
    ).all(String(sessionId || ''));
    const parts = db.prepare(
      'SELECT message_id, sequence, data FROM part WHERE session_id = ? ORDER BY sequence'
    ).all(String(sessionId || ''));
    const partsByMessage = new Map();
    for (const part of parts) {
      const list = partsByMessage.get(part.message_id) || [];
      list.push(part);
      partsByMessage.set(part.message_id, list);
    }
    return messages.map((message) => ({ message, parts: partsByMessage.get(message.id) || [] }));
  } catch (_error) {
    return [];
  } finally {
    try { db.close(); } catch (_error) {}
  }
}

function parseJsonData(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function readZcodePartText(part) {
  const data = parseJsonData(part.data);
  if (data.type && data.type !== 'text') return '';
  return String(data.text || '').trim();
}

function readZcodeSessionMessages(dbPath, sessionId) {
  const messages = [];
  for (const { message, parts } of readZcodeMessageRows(dbPath, sessionId)) {
    const data = parseJsonData(message.data);
    const role = String(data.role || '').trim();
    if (role !== 'user' && role !== 'assistant') continue;
    const text = parts.map(readZcodePartText).filter(Boolean).join('\n');
    if (!text) continue;
    messages.push({
      role,
      content: text,
      timestamp: Number(message.time_created) || null,
      model: data.model || undefined
    });
  }
  return messages;
}

function readZcodeSessionModel(dbPath, sessionId) {
  const rows = readZcodeMessageRows(dbPath, sessionId);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const model = String(parseJsonData(rows[index].message.data).model || '').trim();
    if (model) return model;
  }
  return '';
}

module.exports = {
  openZcodeDatabase,
  readZcodeProjects,
  readZcodeSessionMessages,
  readZcodeSessionModel
};
