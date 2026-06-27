'use strict';

const path = require('node:path');

const {
  isOfficialNativeSessionProvider,
  spawnNativeSessionStream
} = require('./native-session-chat');
const {
  appendNativeChatRunEvent,
  createChatEventMeta,
  getNativeChatRun,
  readNativeChatRunEvents,
  registerNativeChatRun,
  unregisterNativeChatRun
} = require('./native-chat-run-store');
const { ensureCodexProjectRegistered } = require('./codex-project-registry');

const MAX_SESSION_START_PROMPT_LENGTH = 64 * 1024;
const COMPLETED_RUN_RETENTION_MS = 60 * 1000;

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function createSessionStartError(code, statusCode = 400) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizePrompt(value) {
  const prompt = String(value == null ? '' : value);
  if (prompt.length > MAX_SESSION_START_PROMPT_LENGTH) {
    throw createSessionStartError('session_start_prompt_too_large', 413);
  }
  return prompt;
}

function normalizeProvider(value) {
  return normalizeText(value, 64).toLowerCase();
}

function sanitizeClaudeProjectDirName(projectPath) {
  return normalizeText(projectPath, 512).replace(/[^a-zA-Z0-9]/g, '-');
}

function resolveProjectDirName(provider, projectDirName, projectPath) {
  const explicit = normalizeText(projectDirName, 512);
  if (explicit) return explicit;
  if (normalizeProvider(provider) !== 'claude') return '';
  return sanitizeClaudeProjectDirName(projectPath);
}

function normalizeSessionStartPayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const provider = normalizeProvider(source.provider);
  const accountId = normalizeText(source.accountId || source.account_id, 96);
  const prompt = normalizePrompt(source.prompt || source.initialInput || source.initial_input || '');
  const projectPath = normalizeText(source.projectPath || source.project_path, 2048);
  const projectDirName = resolveProjectDirName(provider, source.projectDirName || source.project_dir_name, projectPath);
  const model = normalizeText(source.model, 256);
  const sessionId = normalizeText(source.sessionId || source.session_id, 256);
  const cols = Math.max(20, Math.min(400, Number(source.cols) || 220));
  const rows = Math.max(4, Math.min(200, Number(source.rows) || 32));

  if (!provider) throw createSessionStartError('missing_provider', 400);
  if (!isOfficialNativeSessionProvider(provider)) {
    throw createSessionStartError('native_session_start_unsupported', 400);
  }
  if (!accountId) throw createSessionStartError('missing_account_id', 400);

  return {
    provider,
    accountId,
    prompt,
    projectPath,
    projectDirName,
    model,
    sessionId,
    cols,
    rows
  };
}

function appendRunEvent(runId, event = {}, startedAt = Date.now()) {
  return appendNativeChatRunEvent(runId, {
    ...event,
    ...createChatEventMeta(startedAt)
  });
}

function normalizeRunId(value) {
  return normalizeText(value, 128);
}

function normalizeSessionRunEventsQuery(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const runId = normalizeRunId(source.runId || source.run_id);
  if (!runId) throw createSessionStartError('missing_run_id', 400);
  return {
    runId,
    cursor: Number(source.cursor) || 0,
    limit: Number(source.limit) || 100
  };
}

function normalizeSessionRunInputPayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const runId = normalizeRunId(source.runId || source.run_id);
  const input = String(source.input == null ? '' : source.input);
  if (!runId) throw createSessionStartError('missing_run_id', 400);
  if (!input) throw createSessionStartError('session_input_empty', 400);
  if (input.length > MAX_SESSION_START_PROMPT_LENGTH) {
    throw createSessionStartError('session_input_too_large', 413);
  }
  return {
    runId,
    input,
    appendNewline: source.appendNewline !== false,
    promptId: normalizeText(source.promptId || source.prompt_id, 256)
  };
}

function normalizeSessionRunAbortPayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const runId = normalizeRunId(source.runId || source.run_id);
  if (!runId) throw createSessionStartError('missing_run_id', 400);
  return { runId };
}

function readNativeSessionRunEvents(input = {}) {
  const query = normalizeSessionRunEventsQuery(input);
  const result = readNativeChatRunEvents(query.runId, {
    cursor: query.cursor,
    limit: query.limit
  });
  if (!result) throw createSessionStartError('native_chat_run_not_found', 404);
  return result;
}

function writeNativeSessionRunInput(payload = {}) {
  const input = normalizeSessionRunInputPayload(payload);
  const run = getNativeChatRun(input.runId);
  if (!run || typeof run.writeInput !== 'function') {
    throw createSessionStartError('native_chat_run_not_found', 404);
  }
  try {
    run.writeInput(input.input, {
      appendNewline: input.appendNewline,
      ...(input.promptId ? { promptId: input.promptId } : {})
    });
  } catch (error) {
    throw createSessionStartError(String(error && error.code || 'native_chat_input_failed'), 400);
  }
  return {
    accepted: true,
    runId: input.runId,
    appendNewline: input.appendNewline,
    promptId: input.promptId
  };
}

function abortNativeSessionRun(payload = {}, deps = {}) {
  const input = normalizeSessionRunAbortPayload(payload);
  const run = getNativeChatRun(input.runId);
  if (!run || typeof run.abort !== 'function') {
    throw createSessionStartError('native_chat_run_not_found', 404);
  }
  try {
    run.abort();
  } catch (error) {
    throw createSessionStartError(String(error && error.code || 'native_chat_abort_failed'), 400);
  }
  run.completed = true;
  appendNativeChatRunEvent(input.runId, {
    type: 'aborted',
    runId: input.runId,
    ...createChatEventMeta(Date.now())
  });
  const unregister = typeof deps.unregisterNativeChatRun === 'function'
    ? deps.unregisterNativeChatRun
    : unregisterNativeChatRun;
  scheduleRunCleanup(input.runId, unregister);
  return {
    accepted: true,
    runId: input.runId
  };
}

function scheduleRunCleanup(runId, unregister = unregisterNativeChatRun) {
  const timer = setTimeout(() => unregister(runId), COMPLETED_RUN_RETENTION_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function ensureNativeProjectTrusted(input, deps = {}) {
  if (input.provider !== 'codex' || !input.projectPath) {
    return { ok: true, skipped: true };
  }
  const profileDir = normalizeText(deps.profileDir, 2048);
  const registerProject = typeof deps.ensureCodexProjectRegistered === 'function'
    ? deps.ensureCodexProjectRegistered
    : ensureCodexProjectRegistered;
  return registerProject(input.projectPath, {
    hostHomeDir: profileDir || deps.hostHomeDir,
    codexHomeDir: profileDir ? path.join(profileDir, '.codex') : '',
    processObj: {
      env: deps.env || process.env,
      platform: process.platform
    }
  });
}

function startNativeDeviceSession(payload, deps = {}) {
  const input = normalizeSessionStartPayload(payload);
  const startedAt = Date.now();
  const getProfileDir = deps.getProfileDir;
  if (typeof getProfileDir !== 'function') {
    throw createSessionStartError('native_session_invalid_context', 500);
  }
  const profileDir = getProfileDir(input.provider, input.accountId);
  ensureNativeProjectTrusted(input, {
    ...deps,
    profileDir
  });

  let streamHandle = null;
  const spawnNativeStream = typeof deps.spawnNativeSessionStream === 'function'
    ? deps.spawnNativeSessionStream
    : spawnNativeSessionStream;
  const stream = spawnNativeStream({
    provider: input.provider,
    accountId: input.accountId,
    sessionId: input.sessionId,
    projectDirName: input.projectDirName,
    projectPath: input.projectPath,
    prompt: input.prompt,
    initialInput: '',
    interactiveCli: true,
    emitTerminalOutput: true,
    completeOnTranscriptUpdate: false,
    model: input.model || undefined,
    getProfileDir,
    ensureSessionStoreLinks: deps.ensureSessionStoreLinks,
    env: deps.env || process.env,
    onEvent(event) {
      if (!event) return;
      if (!streamHandle || !streamHandle.runId) return;
      appendRunEvent(streamHandle.runId, event, startedAt);
    }
  });
  streamHandle = stream;

  const runHandle = {
    runId: stream.runId,
    provider: input.provider,
    accountId: input.accountId,
    sessionId: input.sessionId,
    projectDirName: input.projectDirName,
    projectPath: input.projectPath,
    startedAt,
    updatedAt: startedAt,
    events: [],
    eventCursor: 0,
    completed: false,
    abort() {
      if (typeof stream.abort === 'function') stream.abort();
    },
    writeInput(inputText, writeOptions = {}) {
      return stream.writeInput(inputText, writeOptions);
    },
    resize(cols, rows) {
      return stream.resize(cols, rows);
    }
  };
  const register = typeof deps.registerNativeChatRun === 'function'
    ? deps.registerNativeChatRun
    : registerNativeChatRun;
  const unregister = typeof deps.unregisterNativeChatRun === 'function'
    ? deps.unregisterNativeChatRun
    : unregisterNativeChatRun;
  register(runHandle);

  appendRunEvent(stream.runId, {
    type: 'ready',
    mode: 'native-session',
    provider: input.provider,
    accountId: input.accountId,
    sessionId: input.sessionId,
    runId: stream.runId,
    projectDirName: input.projectDirName,
    projectPath: input.projectPath
  }, startedAt);

  try {
    stream.resize(input.cols, input.rows);
  } catch (_error) {}

  stream.done.then((result) => {
    runHandle.completed = true;
    runHandle.sessionId = normalizeText(result && result.sessionId, 256) || runHandle.sessionId;
    appendRunEvent(stream.runId, {
      type: 'done',
      mode: 'native-session',
      provider: input.provider,
      accountId: input.accountId,
      sessionId: runHandle.sessionId,
      runId: stream.runId,
      content: String(result && result.content || '')
    }, startedAt);
    scheduleRunCleanup(stream.runId, unregister);
  }).catch((error) => {
    runHandle.completed = true;
    appendRunEvent(stream.runId, {
      type: 'error',
      mode: 'native-session',
      provider: input.provider,
      accountId: input.accountId,
      sessionId: runHandle.sessionId,
      runId: stream.runId,
      code: String(error && error.code || 'native_session_failed'),
      message: String((error && error.message) || error || 'native_session_failed')
    }, startedAt);
    scheduleRunCleanup(stream.runId, unregister);
  });

  return {
    accepted: true,
    mode: 'native-session',
    status: 'running',
    provider: input.provider,
    accountId: input.accountId,
    sessionId: runHandle.sessionId,
    runId: stream.runId,
    projectDirName: input.projectDirName,
    projectPath: input.projectPath,
    stream: readNativeChatRunEvents(stream.runId, { cursor: 0, limit: 10 })
  };
}

module.exports = {
  MAX_SESSION_START_PROMPT_LENGTH,
  normalizeSessionRunEventsQuery,
  normalizeSessionRunAbortPayload,
  normalizeSessionRunInputPayload,
  normalizeSessionStartPayload,
  abortNativeSessionRun,
  readNativeSessionRunEvents,
  writeNativeSessionRunInput,
  ensureNativeProjectTrusted,
  startNativeDeviceSession
};
