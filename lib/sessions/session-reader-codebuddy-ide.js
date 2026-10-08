'use strict';

const path = require('node:path');
const { getRealHome } = require('./session-reader-utils');
const { discoverCodebuddyIdeSessions, readCodebuddyIdeSession } = require('./codebuddy-ide-store');

function ideOptions(provider, options) {
  const hostHomeDir = options.hostHomeDir || getRealHome();
  return { ...options, hostHomeDir, aiHomeDir: options.aiHomeDir || path.join(hostHomeDir, '.ai_home'), providers: [provider] };
}

function findCodebuddyIdeSession(provider, sessionId, projectDirName, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(String(sessionId || ''))) return null;
  return discoverCodebuddyIdeSessions({ ...ideOptions(provider, options), sessionId })
    .filter(session => !options.accountRef || session.accountRef === options.accountRef)
    .filter(session => !projectDirName || session.projectDirName === projectDirName)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] || null;
}

function readTextBlocks(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).filter(block => block?.type === 'text')
    .map(block => String(block.text || '')).join('\n');
}

function messageText(message) {
  if (message.role === 'user') {
    const source = readTextBlocks(message.extra.sourceContentBlocks);
    if (source.trim()) return source;
  }
  let text;
  try { text = readTextBlocks(JSON.parse(message.message).content); }
  catch (_) { text = typeof message.message === 'string' ? message.message : ''; }
  if (message.role === 'user') {
    // The IDE's request envelope includes project guidance; display only its
    // user query when sourceContentBlocks have not been persisted yet.
    const query = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
    if (query) return query[1];
  }
  return text;
}

function readCodebuddyIdeProjects(provider, options = {}) {
  const projects = new Map();
  for (const session of discoverCodebuddyIdeSessions(ideOptions(provider, options))) {
    const content = readCodebuddyIdeSession(session, options);
    if (!content) continue;
    const messages = [...content.messages.values()];
    const firstUser = messages.find(message => message.role === 'user');
    const updatedAt = Math.max(session.updatedAt, ...messages.map(message => message.timestampMs),
      ...content.requests.map(request => Number(request.startedAt) || 0));
    let project = projects.get(session.projectDirName);
    if (!project) {
      project = { id: session.projectDirName, path: session.cwd || session.projectDirName,
        name: path.basename(session.cwd || session.projectDirName), provider, sessions: [] };
      projects.set(project.id, project);
    }
    const previous = project.sessions.findIndex(row => row.id === session.sessionId);
    const row = { id: session.sessionId, title: (session.title || (firstUser && messageText(firstUser)) || project.name)
      .replace(/\s+/g, ' ').trim().slice(0, 120), updatedAt, provider, projectDirName: session.projectDirName };
    if (previous < 0) project.sessions.push(row);
    else if (row.updatedAt > project.sessions[previous].updatedAt) project.sessions[previous] = row;
  }
  return [...projects.values()].map(project => ({ ...project,
    sessions: project.sessions.sort((left, right) => right.updatedAt - left.updatedAt) }));
}

function readCodebuddyIdeMessages(provider, sessionId, projectDirName, options = {}) {
  const session = findCodebuddyIdeSession(provider, sessionId, projectDirName, options);
  const content = session && readCodebuddyIdeSession(session, options);
  if (!content) return [];
  return [...content.messages.values()].map(message => ({ role: message.role,
    content: messageText(message).trim(), timestamp: message.timestampMs ? new Date(message.timestampMs).toISOString() : '',
    ...(message.role === 'assistant' && message.extra.modelId ? { model: message.extra.modelId } : {}) }))
    .filter(message => message.content);
}

module.exports = { findCodebuddyIdeSession, readCodebuddyIdeProjects, readCodebuddyIdeMessages };
