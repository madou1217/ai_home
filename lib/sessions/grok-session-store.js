'use strict';

const path = require('node:path');
const fs = require('fs-extra');

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_error) { return null; }
}

function readJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch (_error) { return null; }
    }).filter(Boolean);
  } catch (_error) { return []; }
}

function normalizeContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((block) => typeof block === 'string' ? block : block && (block.text || block.content) || '')
    .filter(Boolean).join('\n').trim();
}

function unwrapUserQuery(content) {
  const text = String(content || '').trim();
  const match = text.match(/^<user_query>\s*([\s\S]*?)\s*<\/user_query>$/i);
  return match ? match[1].trim() : text;
}

function listRoots(options) {
  return Array.from(new Set((options.roots || []).map((root) => String(root || '').trim()).filter(Boolean)));
}

function resolveProjectPath(projectDir) {
  try {
    const cwd = fs.readFileSync(path.join(projectDir, '.cwd'), 'utf8').trim();
    if (cwd) return cwd;
  } catch (_error) {}
  try { return decodeURIComponent(path.basename(projectDir)); } catch (_error) { return path.basename(projectDir); }
}

function readGrokProjects(options = {}) {
  const projectsByPath = new Map();
  for (const root of listRoots(options)) {
    if (!fs.existsSync(root)) continue;
    for (const projectName of fs.readdirSync(root)) {
      const projectDir = path.join(root, projectName);
      try { if (!fs.statSync(projectDir).isDirectory()) continue; } catch (_error) { continue; }
      const projectPath = resolveProjectPath(projectDir);
      const projectKey = `${String(options.accountRef || '')}:${path.resolve(projectPath).toLowerCase()}`;
      const existingProject = projectsByPath.get(projectKey);
      const sessionsById = new Map((existingProject && existingProject.sessions || []).map((session) => [session.id, session]));
      for (const sessionId of fs.readdirSync(projectDir)) {
        const sessionDir = path.join(projectDir, sessionId);
        let stat;
        try { stat = fs.statSync(sessionDir); } catch (_error) { continue; }
        if (!stat.isDirectory()) continue;
        const summary = readJson(path.join(sessionDir, 'summary.json')) || {};
        const info = summary.info && typeof summary.info === 'object' ? summary.info : {};
        const id = String(info.session_id || info.id || sessionId);
        const nextSession = { id, title: String(summary.generated_title || summary.session_summary || sessionId), updatedAt: Date.parse(summary.updated_at || summary.created_at || '') || stat.mtimeMs, provider: 'grok', projectDirName: projectName, ...(options.accountRef ? { accountRef: options.accountRef } : {}) };
        const previous = sessionsById.get(id);
        if (!previous || nextSession.updatedAt >= previous.updatedAt) sessionsById.set(id, nextSession);
      }
      if (sessionsById.size === 0) continue;
      projectsByPath.set(projectKey, { id: `grok-${projectName}`, name: path.basename(projectPath) || projectName, path: projectPath, sessions: Array.from(sessionsById.values()).sort((a, b) => b.updatedAt - a.updatedAt), provider: 'grok', ...(options.accountRef ? { accountRef: options.accountRef } : {}) });
    }
  }
  return Array.from(projectsByPath.values());
}

function resolveGrokSessionDir(sessionId, projectDirName, options = {}) {
  const id = String(sessionId || '').trim();
  for (const root of listRoots(options)) {
    if (projectDirName) {
      const candidate = path.join(root, projectDirName, id);
      if (fs.existsSync(candidate)) return candidate;
    } else if (fs.existsSync(root)) {
      for (const projectName of fs.readdirSync(root)) {
        const candidate = path.join(root, projectName, id);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return '';
}

function readGrokSessionMessages(sessionDir) {
  return readJsonl(path.join(sessionDir, 'chat_history.jsonl')).flatMap((record) => {
    const message = record.message && typeof record.message === 'object' ? record.message : record;
    const role = String(message.role || message.type || '');
    const content = role === 'user'
      ? unwrapUserQuery(normalizeContent(message.content))
      : normalizeContent(message.content);
    if (role === 'user' && String(message.synthetic_reason || '').trim()) return [];
    if (role === 'user' && !Number.isInteger(message.prompt_index)) return [];
    return ['user', 'assistant'].includes(role) && content ? [{ role, content, timestamp: message.timestamp || record.timestamp || null, model: message.model || record.model || undefined }] : [];
  });
}

function toolResultText(update) {
  const blocks = Array.isArray(update && update.content) ? update.content : [];
  return blocks.map((block) => {
    const content = block && block.content;
    return String((content && (content.text || content.content)) || block && block.text || '').trim();
  }).filter(Boolean).join('\n');
}

function readGrokTurnState(sessionDir) {
  const records = readJsonl(path.join(sessionDir, 'updates.jsonl'));
  let lastUserIndex = -1;
  records.forEach((record, index) => {
    const update = record && record.params && record.params.update;
    if (update && update.sessionUpdate === 'user_message_chunk') lastUserIndex = index;
  });

  const tools = new Map();
  let lastAssistantIndex = -1;
  let lastTerminalToolIndex = -1;
  for (let index = lastUserIndex + 1; index < records.length; index += 1) {
    const update = records[index] && records[index].params && records[index].params.update;
    if (!update) continue;
    if (update.sessionUpdate === 'agent_message_chunk') lastAssistantIndex = index;
    const toolCallId = String(update.toolCallId || '').trim();
    if (!toolCallId) continue;
    if (update.sessionUpdate === 'tool_call') {
      tools.set(toolCallId, { id: toolCallId, status: 'pending', message: '' });
      continue;
    }
    if (update.sessionUpdate !== 'tool_call_update') continue;
    const status = String(update.status || '').trim().toLowerCase();
    const current = tools.get(toolCallId) || { id: toolCallId, status: 'pending', message: '' };
    if (['completed', 'failed', 'cancelled', 'canceled'].includes(status)) {
      current.status = status;
      current.message = toolResultText(update);
      lastTerminalToolIndex = index;
    }
    tools.set(toolCallId, current);
  }

  const entries = Array.from(tools.values());
  const failed = entries.filter((entry) => entry.status === 'failed');
  return {
    pendingCount: entries.filter((entry) => entry.status === 'pending').length,
    failedCount: failed.length,
    failureMessage: failed.map((entry) => entry.message).find(Boolean) || '',
    hasAssistantAfterTerminalTool: lastAssistantIndex > lastTerminalToolIndex
  };
}

module.exports = {
  readGrokProjects,
  readGrokSessionMessages,
  readGrokTurnState,
  resolveGrokSessionDir
};
