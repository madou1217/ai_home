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
  const projects = [];
  for (const root of listRoots(options)) {
    if (!fs.existsSync(root)) continue;
    for (const projectName of fs.readdirSync(root)) {
      const projectDir = path.join(root, projectName);
      try { if (!fs.statSync(projectDir).isDirectory()) continue; } catch (_error) { continue; }
      const sessions = [];
      for (const sessionId of fs.readdirSync(projectDir)) {
        const sessionDir = path.join(projectDir, sessionId);
        let stat;
        try { stat = fs.statSync(sessionDir); } catch (_error) { continue; }
        if (!stat.isDirectory()) continue;
        const summary = readJson(path.join(sessionDir, 'summary.json')) || {};
        const info = summary.info && typeof summary.info === 'object' ? summary.info : {};
        sessions.push({ id: String(info.session_id || info.id || sessionId), title: String(summary.generated_title || summary.session_summary || sessionId), updatedAt: Date.parse(summary.updated_at || summary.created_at || '') || stat.mtimeMs, provider: 'grok', projectDirName: projectName, ...(options.accountRef ? { accountRef: options.accountRef } : {}) });
      }
      if (sessions.length === 0) continue;
      const projectPath = resolveProjectPath(projectDir);
      projects.push({ id: `grok-${projectName}`, name: path.basename(projectPath) || projectName, path: projectPath, sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt), provider: 'grok', ...(options.accountRef ? { accountRef: options.accountRef } : {}) });
    }
  }
  return projects;
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
    const role = String(message.role || '');
    const content = normalizeContent(message.content);
    return ['user', 'assistant'].includes(role) && content ? [{ role, content, timestamp: message.timestamp || record.timestamp || null, model: message.model || record.model || undefined }] : [];
  });
}

module.exports = { readGrokProjects, readGrokSessionMessages, resolveGrokSessionDir };
