'use strict';

// ZCode 原生运行时把主会话保存在宿主 `~/.zcode/cli/db/db.sqlite`（关系表
// session / message / part，data 列为 JSON），任务列表的标题、工作区、最后活动
// 时间和删除状态保存在同一数据根的 `v2/tasks-index.sqlite`。subagent 会话带
// task_type='subagent_child' 且 parent_id 非空，默认隐藏。
const path = require('node:path');
const { getDatabaseSyncCtor, getSqliteTableColumns } = require('./session-reader-utils');
const { normalizeModelReference } = require('./session-message-metadata');
const { canonicalizeProviderResourcePath } = require('../runtime/provider-resource-path');

function normalizeProjectPath(value) {
  return String(value || '').trim().replace(/^\\\\\?\\/, '');
}

function resolveZcodeDataRoot(dbPath) {
  if (!String(dbPath || '').trim()) return '';
  const dbDir = path.dirname(path.resolve(dbPath));
  const cliDir = path.dirname(dbDir);
  const dataRoot = path.dirname(cliDir);
  return path.basename(dbDir) === 'db' && path.basename(cliDir) === 'cli'
    ? dataRoot
    : '';
}

function openZcodeDatabase(dbPath) {
  const DatabaseSync = getDatabaseSyncCtor();
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

function readZcodeTaskRows(tasksIndexPath) {
  const db = openZcodeDatabase(tasksIndexPath);
  if (!db) return [];
  try {
    const columns = getSqliteTableColumns(db, 'tasks');
    if (!columns.has('task_id')) return [];
    const selectedColumns = [
      'task_id',
      'workspace_path',
      'title',
      'created_at',
      'updated_at',
      'archived',
      'deleted'
    ].filter((column) => columns.has(column));
    return db.prepare(`SELECT ${selectedColumns.join(', ')} FROM tasks`).all();
  } catch (_error) {
    return [];
  } finally {
    try { db.close(); } catch (_error) {}
  }
}

function isTruthySqliteFlag(value) {
  return value === true || Number(value) === 1;
}

function normalizeZcodeModelReference(data) {
  return normalizeModelReference(data.model) || normalizeModelReference({
    providerID: data.providerID,
    modelID: data.modelID
  });
}

function readZcodeProjects(dbPath, options = {}) {
  const projectsByPath = new Map();
  const sessionRowsById = new Map(readZcodeSessions(dbPath).map((row) => [String(row.id || '').trim(), row]));
  const dataRoot = resolveZcodeDataRoot(dbPath);
  const taskRowsById = new Map();
  const taskRows = dataRoot ? readZcodeTaskRows(path.join(dataRoot, 'v2', 'tasks-index.sqlite')) : [];
  for (const row of taskRows) {
    const id = String(row.task_id || '').trim();
    if (!id) continue;
    const previous = taskRowsById.get(id);
    if (!previous || Number(row.updated_at) > Number(previous.updated_at)) {
      taskRowsById.set(id, row);
    }
  }

  const hostHomeDir = dataRoot ? path.dirname(dataRoot) : '';
  // 按 id 合并两份原生事实。旧版无任务索引仍可读取 CLI 会话；索引独有任务也可见。
  for (const id of new Set([...sessionRowsById.keys(), ...taskRowsById.keys()])) {
    const row = sessionRowsById.get(id) || {};
    const task = taskRowsById.get(id) || {};
    if (!id || String(row.parent_id || '').trim() || row.task_type === 'subagent_child') continue;
    if (isTruthySqliteFlag(task.deleted) || isTruthySqliteFlag(task.archived)) continue;
    const projectPath = canonicalizeProviderResourcePath(
      normalizeProjectPath(task.workspace_path || row.directory || row.path),
      { provider: 'zcode', hostHomeDir, aiHomeDir: path.join(hostHomeDir, '.ai_home') }
    );
    if (!projectPath) continue;
    const createdAt = Number(task.created_at || row.time_created) || 0;
    // 续聊写入会话库先于桌面索引；取两份最新时间，不能被稍旧索引拖回过去。
    const updatedAt = Math.max(Number(task.updated_at) || 0, Number(row.time_updated) || 0) || createdAt;
    const session = {
      id,
      title: String(task.title || row.title || '').trim().slice(0, 80) || id,
      updatedAt,
      createdAt,
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
    sessions: Array.from(sessions.values()).sort((a, b) => (
      b.updatedAt - a.updatedAt || String(a.id).localeCompare(String(b.id))
    )),
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
      model: normalizeZcodeModelReference(data) || undefined
    });
  }
  return messages;
}

function readZcodeSessionModel(dbPath, sessionId) {
  const rows = readZcodeMessageRows(dbPath, sessionId);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const model = normalizeZcodeModelReference(parseJsonData(rows[index].message.data));
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
