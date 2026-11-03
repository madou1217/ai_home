'use strict';

const path = require('node:path');
const { readKiroJsonlProjects, readKiroJsonlMessages, readKiroJsonlModel } = require('./kiro-jsonl-store');
const { toTimestampMs } = require('./session-reader-utils');

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

/**
 * 宿主级 kiro 会话：`~/.kiro/sessions/<sha256(cwd)[:16]>/sess_<uuid>/{session.json,messages.jsonl}`。
 *
 * 这套布局是 **kiro CLI 自己**的（不是账号投影），`lib/usage/kiro-session-usage.js` 已经在读同一份
 * 目录（那里只取用量，这里取「会话 id + 标题」）。会话 id 就是 `sess_<uuid>` 目录名，
 * 用户拿它进 kiro 的 TUI 续接；项目路径取 session.json 的 workspacePaths[0]（组名是 sha256 前缀，
 * 不可逆，所以只能从元数据拿）。
 */
function readKiroHostProjects(options = {}) {
  const fsImpl = options.fs || require('node:fs');
  const pathImpl = options.path || path;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  if (!hostHomeDir) return [];
  const root = pathImpl.join(hostHomeDir, '.kiro', 'sessions');
  const projectsByPath = new Map();
  let groups = [];
  try {
    groups = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
  for (const group of groups) {
    if (!group || !group.isDirectory || !group.isDirectory()) continue;
    if (!/^[0-9a-f]{16}$/.test(String(group.name || ''))) continue;
    const groupDir = pathImpl.join(root, group.name);
    let entries = [];
    try {
      entries = fsImpl.readdirSync(groupDir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      if (!entry || !entry.isDirectory || !entry.isDirectory()) continue;
      const sessionId = String(entry.name || '');
      if (!sessionId.startsWith('sess_')) continue;
      const sessionDir = pathImpl.join(groupDir, sessionId);
      let meta = {};
      try {
        meta = JSON.parse(fsImpl.readFileSync(pathImpl.join(sessionDir, 'session.json'), 'utf8')) || {};
      } catch (_error) {
        meta = {};
      }
      const workspaces = Array.isArray(meta.workspacePaths) ? meta.workspacePaths : [];
      const projectPath = String(workspaces[0] || '').trim() || group.name;
      const title = readKiroHostSessionTitle(fsImpl, pathImpl, pathImpl.join(sessionDir, 'messages.jsonl')) || sessionId;
      const updatedAt = Number(toTimestampMs(meta.createdAt)) || 0;
      const project = projectsByPath.get(projectPath) || new Map();
      project.set(sessionId, {
        id: sessionId,
        title,
        updatedAt,
        provider: 'kiro',
        projectDirName: projectPath,
        ...(meta.modelId ? { model: String(meta.modelId) } : {})
      });
      projectsByPath.set(projectPath, project);
    }
  }
  return Array.from(projectsByPath.entries()).map(([projectPath, sessions]) => ({
    id: `kiro-${Buffer.from(projectPath).toString('base64url')}`,
    name: pathImpl.basename(projectPath) || projectPath,
    path: projectPath,
    provider: 'kiro',
    sessions: Array.from(sessions.values()).sort((left, right) => right.updatedAt - left.updatedAt)
  }));
}

/** 标题 = messages.jsonl 里第一条用户提示（只读文件头部若干行，别把整段历史读进内存）。 */
function readKiroHostSessionTitle(fsImpl, pathImpl, messagesPath, options = {}) {
  const maxBytes = Number(options.maxBytes) || 64 * 1024;
  let text = '';
  try {
    const fd = fsImpl.openSync(messagesPath, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const read = fsImpl.readSync(fd, buffer, 0, maxBytes, 0);
      text = buffer.slice(0, read).toString('utf8');
    } finally {
      fsImpl.closeSync(fd);
    }
  } catch (_error) {
    return '';
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (_error) {
      continue;
    }
    const prompt = extractKiroPromptText(record && record.payload);
    if (prompt) return prompt.slice(0, 80);
  }
  return '';
}

/** messages.jsonl 的 payload 形状不固定（不同 kiro 版本嵌套层级不同），只做保守的逐层查找。 */
function extractKiroPromptText(payload) {
  const candidates = [
    payload && payload.userInputMessage && payload.userInputMessage.content,
    payload && payload.user && payload.user.content && payload.user.content.Prompt && payload.user.content.Prompt.prompt,
    payload && payload.content,
    payload && payload.prompt,
    payload && payload.message
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
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
  const legacy = Array.from(projectsByPath.entries()).map(([projectPath, sessions]) => ({
    id: `kiro-${Buffer.from(projectPath).toString('base64url')}`,
    name: path.basename(projectPath) || projectPath,
    path: projectPath,
    sessions: Array.from(sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt),
    provider: 'kiro',
    ...(options.accountRef ? { accountRef: options.accountRef } : {})
  }));
  const projects = new Map(legacy.map(project => [project.path, project]));
  for (const project of readKiroJsonlProjects(dbPath, options)) {
    const previous = projects.get(project.path);
    if (!previous) projects.set(project.path, project);
    else {
      const sessions = new Map(previous.sessions.map(session => [session.id, session]));
      for (const session of project.sessions) sessions.set(session.id, session);
      previous.sessions = [...sessions.values()];
    }
  }
  return [...projects.values()].map(project => ({ ...project,
    sessions: project.sessions.sort((left, right) => right.updatedAt - left.updatedAt) }));
}

function findConversation(dbPath, sessionId) {
  return readKiroConversations(dbPath).find((item) => String(item.row.conversation_id) === String(sessionId)) || null;
}

function readKiroSessionMessages(dbPath, sessionId) {
  const current = readKiroJsonlMessages(dbPath, sessionId);
  if (current) return current;
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
  const current = readKiroJsonlModel(dbPath, sessionId);
  if (current) return current;
  const conversation = findConversation(dbPath, sessionId);
  if (!conversation) return '';
  const history = Array.isArray(conversation.value.history) ? conversation.value.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const model = String(history[index] && history[index].request_metadata && history[index].request_metadata.model_id || '').trim();
    if (model) return model;
  }
  return String(conversation.value.model_info && conversation.value.model_info.model_id || '').trim();
}

module.exports = { readKiroHostProjects, readKiroProjects, readKiroSessionMessages, readKiroSessionModel };
