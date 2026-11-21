'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { forEachJsonlLineSync } = require('./session-reader-utils');

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

function canonicalFile(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(file) === path.resolve(file) ? stat : null;
  } catch (_) { return null; }
}

function readMetadata(dbPath, sessionId) {
  if (!dbPath || !ID.test(String(sessionId || ''))) return null;
  const root = path.join(path.dirname(dbPath), '.kiro', 'sessions', 'cli');
  const file = path.join(root, `${sessionId}.json`);
  const stat = canonicalFile(file);
  if (!stat || stat.size > MAX_METADATA_BYTES) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (meta.session_id !== sessionId || typeof meta.cwd !== 'string' || !path.isAbsolute(meta.cwd)) return null;
    return { meta, stat, transcriptPath: path.join(root, `${sessionId}.jsonl`) };
  } catch (_) { return null; }
}

function resolveKiroJsonlPath(dbPath, sessionId) {
  const entry = readMetadata(dbPath, sessionId);
  return entry && canonicalFile(entry.transcriptPath) ? entry.transcriptPath : '';
}

function readKiroJsonlProjects(dbPath, options = {}) {
  if (!dbPath) return [];
  const root = path.join(path.dirname(dbPath), '.kiro', 'sessions', 'cli');
  const projects = new Map();
  let names;
  try { names = fs.readdirSync(root); } catch (_) { return []; }
  for (const name of names) {
    if (!name.endsWith('.json') || !ID.test(name.slice(0, -5))) continue;
    const id = name.slice(0, -5);
    const entry = readMetadata(dbPath, id);
    if (!entry) continue;
    const { meta, stat, transcriptPath } = entry;
    const transcriptStat = canonicalFile(transcriptPath);
    if (!transcriptStat) continue;
    const projectPath = meta.cwd;
    const project = projects.get(projectPath) || {
      id: `kiro-${Buffer.from(projectPath).toString('base64url')}`, name: path.basename(projectPath) || projectPath,
      path: projectPath, provider: 'kiro', sessions: [], ...(options.accountRef ? { accountRef: options.accountRef } : {})
    };
    project.sessions.push({ id, title: String(meta.title || id).trim().slice(0, 120), provider: 'kiro',
      projectDirName: projectPath, updatedAt: Math.max(Date.parse(meta.updated_at) || 0, stat.mtimeMs, transcriptStat.mtimeMs),
      ...(options.accountRef ? { accountRef: options.accountRef } : {}) });
    projects.set(projectPath, project);
  }
  return [...projects.values()];
}

function readKiroJsonlMessages(dbPath, sessionId) {
  const entry = readMetadata(dbPath, sessionId);
  if (!entry || !canonicalFile(entry.transcriptPath)) return null;
  const turns = entry.meta.session_state?.conversation_metadata?.user_turn_metadatas || [];
  const metadataById = new Map();
  for (const turn of Array.isArray(turns) ? turns : []) {
    for (const id of Array.isArray(turn.message_ids) ? turn.message_ids : []) metadataById.set(id, turn);
  }
  const messages = [];
  try {
    forEachJsonlLineSync(entry.transcriptPath, line => {
      let event;
      try { event = JSON.parse(line); } catch (_) { return; }
      if (event.version !== 'v1' || !['Prompt', 'AssistantMessage'].includes(event.kind)) return;
      const data = event.data;
      const text = (Array.isArray(data?.content) ? data.content : [])
        .filter(block => block.kind === 'text' && typeof block.data === 'string').map(block => block.data).join('\n').trim();
      if (!text) return;
      const turn = metadataById.get(data.message_id);
      const timestamp = data.meta?.timestamp || (event.kind === 'AssistantMessage' ? turn?.result?.Ok?.meta?.timestamp : 0);
      const model = String(turn?.model || entry.meta.session_state?.rts_model_state?.model_info?.model_id || '');
      messages.push({ role: event.kind === 'Prompt' ? 'user' : 'assistant', content: text,
        ...(model ? { model } : {}),
        ...(typeof timestamp === 'number' && timestamp > 0 ? { timestamp: new Date(timestamp * 1000).toISOString() } : {}) });
    });
  } catch (_) { return null; }
  return messages;
}

function readKiroJsonlModel(dbPath, sessionId) {
  const entry = readMetadata(dbPath, sessionId);
  if (!entry) return '';
  const state = entry.meta.session_state;
  const turns = state?.conversation_metadata?.user_turn_metadatas;
  return String((Array.isArray(turns) && turns.at(-1)?.model) || state?.rts_model_state?.model_info?.model_id || '');
}

module.exports = { readKiroJsonlProjects, readKiroJsonlMessages, readKiroJsonlModel, resolveKiroJsonlPath };
