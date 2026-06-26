'use strict';

const { isSupportedProvider } = require('./providers');

const DEFAULT_SOURCE = 'official-hook';

const EVENT_TYPE_BY_NAME = Object.freeze({
  SessionStart: 'session:opened',
  Setup: 'session:updated',
  UserPromptSubmit: 'session:turn-started',
  UserPromptExpansion: 'session:turn-started',
  AppServerTurnStarted: 'session:turn-started',
  BeforeAgent: 'session:turn-started',
  PreToolUse: 'session:turn-updated',
  PermissionRequest: 'session:turn-updated',
  PermissionDenied: 'session:turn-updated',
  PostToolUse: 'session:turn-updated',
  PostToolUseFailure: 'session:turn-updated',
  PostToolBatch: 'session:turn-updated',
  BeforeTool: 'session:turn-updated',
  AfterTool: 'session:turn-updated',
  BeforeToolSelection: 'session:turn-updated',
  BeforeModel: 'session:turn-updated',
  AfterModel: 'session:turn-updated',
  PreInvocation: 'session:turn-updated',
  PostInvocation: 'session:turn-updated',
  AppServerThreadStatusChanged: 'session:turn-updated',
  Notification: 'session:notification',
  MessageDisplay: 'session:turn-updated',
  SubagentStart: 'session:turn-updated',
  TaskCreated: 'session:turn-updated',
  TaskCompleted: 'session:turn-updated',
  Stop: 'session:turn-completed',
  AppServerTurnCompleted: 'session:turn-completed',
  StopFailure: 'session:turn-failed',
  AfterAgent: 'session:turn-completed',
  SubagentStop: 'session:turn-completed',
  TeammateIdle: 'session:turn-updated',
  InstructionsLoaded: 'session:updated',
  ConfigChange: 'session:updated',
  CwdChanged: 'session:updated',
  FileChanged: 'session:file-changed',
  WorktreeCreate: 'session:updated',
  WorktreeRemove: 'session:updated',
  PreCompact: 'session:updated',
  PostCompact: 'session:updated',
  PreCompress: 'session:updated',
  Elicitation: 'session:turn-updated',
  ElicitationResult: 'session:turn-updated',
  SessionEnd: 'session:closed',
  AppServerThreadClosed: 'session:closed'
});

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeProvider(value) {
  return normalizeText(value).toLowerCase();
}

function firstText(values) {
  for (const value of values) {
    const text = normalizeText(value);
    if (text) return text;
  }
  return '';
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstWorkspacePath(payload) {
  const paths = Array.isArray(payload.workspacePaths)
    ? payload.workspacePaths
    : Array.isArray(payload.workspace_paths)
      ? payload.workspace_paths
      : [];
  return firstText(paths);
}

function parseEventTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = normalizeText(value);
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function inferAgyEventName(payload) {
  if (payload.executionNum !== undefined || payload.fullyIdle !== undefined || payload.terminationReason !== undefined) {
    return 'Stop';
  }
  if (payload.toolCall && typeof payload.toolCall === 'object') {
    return 'PreToolUse';
  }
  if (payload.error !== undefined && payload.stepIdx !== undefined) {
    return 'PostToolUse';
  }
  return '';
}

function resolveHookEventName(provider, payload, options = {}) {
  const explicitName = firstText([
    options.eventName,
    options.hookEventName,
    payload.eventName,
    payload.hookEventName,
    payload.hook_event_name,
    payload.event
  ]);
  if (explicitName) return explicitName;
  if (provider === 'agy') return inferAgyEventName(payload);
  return '';
}

function resolveSessionId(provider, payload, options = {}) {
  if (provider === 'agy') {
    return firstText([
      options.sessionId,
      payload.conversationId,
      payload.conversation_id,
      payload.sessionId,
      payload.session_id
    ]);
  }
  return firstText([
    options.sessionId,
    payload.session_id,
    payload.sessionId
  ]);
}

function resolveTranscriptPath(provider, payload) {
  if (provider === 'agy') {
    return firstText([payload.transcriptPath, payload.transcript_path]);
  }
  return firstText([payload.transcript_path, payload.transcriptPath]);
}

function resolveProjectPath(provider, payload, options = {}) {
  return firstText([
    options.projectPath,
    payload.projectPath,
    payload.project_path,
    payload.cwd,
    provider === 'agy' ? firstWorkspacePath(payload) : ''
  ]);
}

function resolveTurnId(payload) {
  return firstText([
    payload.turn_id,
    payload.turnId,
    payload.invocationNum,
    payload.executionNum,
    payload.stepIdx
  ]);
}

function resolveEventType(eventName, provider, payload) {
  if (provider === 'agy' && eventName === 'Stop') {
    if (normalizeText(payload.error) || normalizeText(payload.terminationReason).toLowerCase() === 'error') {
      return 'session:turn-failed';
    }
    if (payload.fullyIdle === false) return 'session:turn-updated';
    return 'session:turn-completed';
  }
  return EVENT_TYPE_BY_NAME[eventName] || 'session:updated';
}

function resolvePhase(type) {
  if (type === 'session:opened') return 'session-opened';
  if (type === 'session:closed') return 'session-closed';
  if (type === 'session:turn-started') return 'turn-started';
  if (type === 'session:turn-completed') return 'turn-completed';
  if (type === 'session:turn-failed') return 'turn-failed';
  if (type === 'session:file-changed') return 'file-changed';
  if (type === 'session:notification') return 'notification';
  return 'turn-updated';
}

function normalizeProviderHookEvent(providerRaw, rawPayload, options = {}) {
  const payload = asObject(rawPayload);
  const provider = normalizeProvider(providerRaw || payload.provider);
  if (!isSupportedProvider(provider)) {
    return { ok: false, error: 'unsupported_provider' };
  }

  const eventName = resolveHookEventName(provider, payload, options);
  const sessionId = resolveSessionId(provider, payload, options);
  if (!sessionId) {
    return { ok: false, error: 'missing_session_id' };
  }

  const type = resolveEventType(eventName, provider, payload);
  const transcriptPath = resolveTranscriptPath(provider, payload);
  const projectPath = resolveProjectPath(provider, payload, options);
  const projectDirName = firstText([
    options.projectDirName,
    payload.projectDirName,
    payload.project_dir_name
  ]);
  const cwd = firstText([payload.cwd, projectPath]);
  const at = parseEventTime(payload.timestamp || payload.at) || Number(options.at) || Date.now();
  const turnId = resolveTurnId(payload);

  return {
    ok: true,
    session: {
      provider,
      sessionId,
      projectDirName,
      projectPath
    },
    event: {
      type,
      source: normalizeText(options.source || payload.source) || DEFAULT_SOURCE,
      reason: eventName || type,
      eventName,
      phase: resolvePhase(type),
      transcriptPath,
      cwd,
      projectPath,
      projectDirName,
      turnId,
      at
    }
  };
}

module.exports = {
  normalizeProviderHookEvent,
  resolveEventType
};
