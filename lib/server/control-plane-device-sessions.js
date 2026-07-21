'use strict';

const crypto = require('node:crypto');
const { applyEventSeq } = require('./control-plane-device-session-event-store');

const SESSION_REF_PREFIX = 'sess_';
const PROJECT_REF_PREFIX = 'proj_';
const PUBLIC_REF_HASH_LENGTH = 20;
const DEFAULT_SESSION_LIMIT = 100;
const DEFAULT_MESSAGE_LIMIT = 40;
const MAX_MESSAGE_LIMIT = 200;
const MAX_MESSAGE_CONTENT_LENGTH = 12000;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 500;

function normalizeText(value, maxLength = 160) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeCount(value) {
  return Math.max(0, Math.floor(normalizeNumber(value, 0)));
}

function normalizeTimestamp(value) {
  return Math.max(0, Math.floor(normalizeNumber(value, 0)));
}

function normalizeLimit(value) {
  const limit = normalizeCount(value || DEFAULT_SESSION_LIMIT);
  return Math.max(1, Math.min(500, limit));
}

function normalizeMessageLimit(value) {
  const limit = normalizeCount(value || DEFAULT_MESSAGE_LIMIT);
  return Math.max(1, Math.min(MAX_MESSAGE_LIMIT, limit));
}

function normalizeEventLimit(value) {
  const limit = normalizeCount(value || DEFAULT_EVENT_LIMIT);
  return Math.max(1, Math.min(MAX_EVENT_LIMIT, limit));
}

function normalizeProvider(value) {
  const provider = normalizeText(value, 64).toLowerCase();
  return provider || 'unknown';
}

function normalizeSessionRef(value) {
  const ref = normalizeText(value, 96);
  return /^sess_[a-f0-9]{20}$/.test(ref) ? ref : '';
}

function normalizeSessionStatus(session) {
  const status = normalizeText(session && session.status, 32).toLowerCase();
  if (status === 'running') return 'running';
  if (session && session.draft) return 'draft';
  if (status === 'failed' || status === 'error') return 'failed';
  return 'idle';
}

function buildPublicRef(prefix, parts) {
  const identity = (Array.isArray(parts) ? parts : [])
    .map((part) => String(part == null ? '' : part).trim())
    .filter(Boolean)
    .join('\n');
  if (!identity) return '';
  const digest = crypto.createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, PUBLIC_REF_HASH_LENGTH);
  return `${prefix}${digest}`;
}

function buildProjectRef(project) {
  const source = project && typeof project === 'object' ? project : {};
  return buildPublicRef(PROJECT_REF_PREFIX, [
    source.path,
    source.id,
    source.name
  ]);
}

function buildSessionRef(project, session, provider) {
  const source = session && typeof session === 'object' ? session : {};
  return buildPublicRef(SESSION_REF_PREFIX, [
    provider,
    source.id,
    source.projectDirName,
    source.projectPath,
    project && project.path,
    project && project.id
  ]);
}

function serializeDeviceSession(project, session) {
  const projectSource = project && typeof project === 'object' ? project : {};
  const sessionSource = session && typeof session === 'object' ? session : {};
  const provider = normalizeProvider(sessionSource.provider || projectSource.provider);
  const sessionRef = buildSessionRef(projectSource, sessionSource, provider);
  const projectRef = buildProjectRef(projectSource);
  if (!sessionRef || !projectRef || provider === 'unknown') return null;
  return {
    sessionRef,
    projectRef,
    provider,
    title: normalizeText(sessionSource.title || sessionSource.id || 'Untitled session', 160),
    projectName: normalizeText(projectSource.name, 120) || 'Untitled project',
    status: normalizeSessionStatus(sessionSource),
    updatedAt: normalizeTimestamp(sessionSource.updatedAt),
    startedAt: normalizeTimestamp(sessionSource.startedAt)
  };
}

function collectDeviceSessions(projects) {
  const source = Array.isArray(projects) ? projects : [];
  const sessions = [];
  source.forEach((project) => {
    const projectSessions = Array.isArray(project && project.sessions) ? project.sessions : [];
    projectSessions.forEach((session) => {
      const item = serializeDeviceSession(project, session);
      if (item) sessions.push(item);
    });
  });
  return sessions.sort((left, right) => right.updatedAt - left.updatedAt
    || left.provider.localeCompare(right.provider)
    || left.title.localeCompare(right.title)
    || left.sessionRef.localeCompare(right.sessionRef));
}

function summarizeDeviceSessions(allSessions, returnedSessions) {
  const summary = {
    total: allSessions.length,
    returned: returnedSessions.length,
    byProvider: {},
    byStatus: {},
    byProject: {},
    recentlyUpdatedAt: 0
  };
  allSessions.forEach((session) => {
    summary.byProvider[session.provider] = normalizeCount(summary.byProvider[session.provider]) + 1;
    summary.byStatus[session.status] = normalizeCount(summary.byStatus[session.status]) + 1;
    summary.byProject[session.projectRef] = normalizeCount(summary.byProject[session.projectRef]) + 1;
    summary.recentlyUpdatedAt = Math.max(summary.recentlyUpdatedAt, normalizeTimestamp(session.updatedAt));
  });
  return summary;
}

function normalizeProjectsFromSnapshot(projectSnapshot) {
  if (Array.isArray(projectSnapshot)) return projectSnapshot;
  const source = projectSnapshot && typeof projectSnapshot === 'object' ? projectSnapshot : {};
  return Array.isArray(source.projects) ? source.projects : [];
}

function buildControlPlaneDeviceSessions(projectSnapshot, options = {}) {
  const allSessions = collectDeviceSessions(normalizeProjectsFromSnapshot(projectSnapshot));
  const limit = normalizeLimit(options.limit);
  const sessions = allSessions.slice(0, limit);
  return {
    sessions,
    summary: summarizeDeviceSessions(allSessions, sessions)
  };
}

function resolveDeviceSession(projectSnapshot, sessionRef) {
  const ref = normalizeSessionRef(sessionRef);
  if (!ref) return null;
  const projects = normalizeProjectsFromSnapshot(projectSnapshot);
  for (const project of projects) {
    const projectSessions = Array.isArray(project && project.sessions) ? project.sessions : [];
    for (const session of projectSessions) {
      const publicSession = serializeDeviceSession(project, session);
      if (!publicSession || publicSession.sessionRef !== ref) continue;
      const source = session && typeof session === 'object' ? session : {};
      const sessionId = normalizeText(source.id, 256);
      if (!sessionId) return null;
      return {
        session: publicSession,
        readerParams: {
          provider: publicSession.provider,
          sessionId,
          projectDirName: normalizeText(source.projectDirName, 256)
        }
      };
    }
  }
  return null;
}

function normalizeMessageRole(value) {
  const role = normalizeText(value, 32).toLowerCase();
  if (role === 'assistant') return 'assistant';
  if (role === 'user') return 'user';
  return '';
}

function stripToolSections(value) {
  return normalizeText(value, MAX_MESSAGE_CONTENT_LENGTH)
    .replace(/\n?:::tool\b[\s\S]*?\n:::\n?/g, '\n')
    .replace(/\n?:::tool-result\b[\s\S]*?\n:::\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeDeviceSessionMessage(value) {
  const source = value && typeof value === 'object' ? value : {};
  const role = normalizeMessageRole(source.role);
  if (!role) return null;
  const content = stripToolSections(source.content);
  if (!content) return null;
  const timestamp = typeof source.timestamp === 'number'
    ? Math.max(0, Number(source.timestamp) || 0)
    : normalizeText(source.timestamp, 128);
  return {
    role,
    content,
    timestamp
  };
}

function normalizeDeviceSessionEvent(value) {
  const source = value && typeof value === 'object' ? value : {};
  const type = normalizeText(source.type, 64);
  const timestamp = normalizeText(source.timestamp, 128);
  const seq = normalizeCount(source.seq || source.cursor || source.sequence);
  const base = seq ? {
    seq,
    cursor: normalizeCount(source.cursor) || seq
  } : {};
  if (type === 'user_message') {
    const content = stripToolSections(source.content);
    return content ? { ...base, type, timestamp, content } : null;
  }
  if (type === 'assistant_text' || type === 'assistant_reasoning') {
    const text = stripToolSections(source.text);
    return text ? { ...base, type, timestamp, text } : null;
  }
  if (type === 'interactive-prompt') {
    const prompt = source.prompt && typeof source.prompt === 'object' ? source.prompt : {};
    const approvalId = normalizeText(prompt.promptId || source.promptId || source.prompt_id, 256);
    const question = normalizeText(prompt.question || source.question, 2048);
    const options = (Array.isArray(prompt.options) ? prompt.options : [])
      .map((option) => {
        const item = option && typeof option === 'object' ? option : {};
        const value = normalizeText(item.value, 64);
        const title = normalizeText(item.title || item.label, 512);
        if (!value || !title) return null;
        const description = normalizeText(item.description, 1024);
        return {
          value,
          title,
          ...(description ? { description } : {})
        };
      })
      .filter(Boolean);
    if (!approvalId || !question || options.length === 0) return null;
    return {
      ...base,
      type: 'approval_request',
      timestamp,
      approvalId,
      provider: normalizeText(prompt.provider || source.provider, 64),
      kind: normalizeText(prompt.kind || source.kind, 64) || 'interactive-prompt',
      question,
      options
    };
  }
  if (type === 'interactive-prompt-cleared') {
    const approvalId = normalizeText(source.promptId || source.prompt_id || source.approvalId || source.approval_id, 256);
    if (!approvalId) return null;
    return {
      ...base,
      type: 'approval_cleared',
      timestamp,
      approvalId,
      reason: normalizeText(source.reason, 128) || 'cleared'
    };
  }
  if (type === 'artifact_ref') {
    const artifact = source.artifact && typeof source.artifact === 'object' ? source.artifact : {};
    const artifactId = normalizeText(source.artifactId || source.artifact_id || artifact.artifactId || artifact.artifact_id, 128);
    if (!artifactId) return null;
    return {
      ...base,
      type: 'artifact_ref',
      timestamp,
      artifact: {
        artifactId,
        kind: normalizeText(source.artifactKind || source.kind || artifact.kind, 64) || 'text',
        title: normalizeText(artifact.title || source.title, 160) || 'Session artifact',
        mimeType: normalizeText(artifact.mimeType || artifact.mime_type || source.mimeType || source.mime_type, 128) || 'text/plain',
        byteLength: normalizeCount(artifact.byteLength || artifact.byte_length || source.byteLength || source.byte_length),
        preview: normalizeText(artifact.preview || source.preview, 512)
      }
    };
  }
  return null;
}

function buildControlPlaneDeviceSessionMessages(projectSnapshot, input = {}, deps = {}) {
  const resolved = resolveDeviceSession(projectSnapshot, input.sessionRef);
  if (!resolved) return null;
  const readMessages = typeof deps.readSessionMessages === 'function'
    ? deps.readSessionMessages
    : () => [];
  const getCursor = typeof deps.getSessionFileCursor === 'function'
    ? deps.getSessionFileCursor
    : () => 0;
  const params = resolved.readerParams;
  const rawMessages = readMessages(params.provider, {
    sessionId: params.sessionId,
    projectDirName: params.projectDirName
  });
  const allMessages = (Array.isArray(rawMessages) ? rawMessages : [])
    .map(normalizeDeviceSessionMessage)
    .filter(Boolean);
  const limit = normalizeMessageLimit(input.limit);
  const startIndex = Math.max(0, allMessages.length - limit);
  const messages = allMessages.slice(startIndex);
  return {
    session: resolved.session,
    messages,
    summary: {
      total: allMessages.length,
      returned: messages.length,
      truncated: startIndex > 0,
      cursor: Math.max(0, Number(getCursor(params.provider, {
        sessionId: params.sessionId,
        projectDirName: params.projectDirName
      })) || 0)
    }
  };
}

function buildControlPlaneDeviceSessionEvents(projectSnapshot, input = {}, deps = {}) {
  const resolved = resolveDeviceSession(projectSnapshot, input.sessionRef);
  if (!resolved) return null;
  const readEvents = typeof deps.readSessionEvents === 'function'
    ? deps.readSessionEvents
    : () => ({ events: [], cursor: 0, requiresSnapshot: true });
  const params = resolved.readerParams;
  const payload = readEvents(params.provider, {
    sessionId: params.sessionId,
    projectDirName: params.projectDirName
  }, {
    cursor: normalizeCount(input.cursor)
  });
  const rawEvents = Array.isArray(payload && payload.events) ? payload.events : [];
  const cursor = Math.max(0, Number(payload && payload.cursor) || 0);
  const normalizedEvents = applyEventSeq(rawEvents, cursor)
    .map(normalizeDeviceSessionEvent)
    .filter(Boolean);
  const limit = normalizeEventLimit(input.limit);
  const truncated = normalizedEvents.length > limit;
  const droppedUnsafeEvents = normalizedEvents.length !== rawEvents.length;
  return {
    session: resolved.session,
    events: truncated ? [] : normalizedEvents,
    cursor,
    requiresSnapshot: Boolean(payload && payload.requiresSnapshot) || droppedUnsafeEvents || truncated,
    truncated
  };
}

module.exports = {
  buildControlPlaneDeviceSessionEvents,
  buildControlPlaneDeviceSessions,
  buildControlPlaneDeviceSessionMessages,
  resolveDeviceSession,
  serializeDeviceSession
};
