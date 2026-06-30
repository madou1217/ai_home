'use strict';

const {
  abortNativeSessionRun,
  readNativeSessionRunEvents,
  startNativeDeviceSession,
  writeNativeSessionRunInput
} = require('./control-plane-device-session-start');
const { writeDeviceSessionInput } = require('./control-plane-device-session-input');
const { getNativeChatRun } = require('./native-chat-run-store');

const MAX_COMMAND_TEXT_LENGTH = 64 * 1024;
const SESSION_REF_PATTERN = /^sess_[a-f0-9]{20}$/;
const COMMAND_TYPES = Object.freeze(['message', 'slash', 'approval_response', 'stop']);
const HEADLESS_RESUME_PROVIDERS = new Set(['claude', 'opencode']);
const SESSION_COMMAND_SETTLE_DELAY_MS = 240;
const sessionCommandAcks = new Map();
const sessionCommandQueues = new Map();

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeInputText(value, code) {
  const text = String(value == null ? '' : value);
  if (!text) throw createSessionCommandError(code, 400);
  if (text.length > MAX_COMMAND_TEXT_LENGTH) {
    throw createSessionCommandError('session_command_input_too_large', 413);
  }
  return text;
}

function createSessionCommandError(code, statusCode = 400) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeCommandType(value) {
  const type = normalizeText(value, 64).replace(/[.-]/g, '_').toLowerCase();
  if (type === 'approvalresponse' || type === 'approval') return 'approval_response';
  return type;
}

function normalizeCommandId(value, idempotencyKey) {
  return normalizeText(value, 128) || idempotencyKey;
}

function normalizeCommandArgs(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeText(item, 2048))
      .filter(Boolean)
      .join(' ');
  }
  return normalizeText(value, MAX_COMMAND_TEXT_LENGTH);
}

function hasPromptLikeField(source) {
  return Boolean(normalizeText(source.promptId || source.prompt_id || source.approvalId || source.approval_id, 256));
}

function normalizeDecision(value) {
  const decision = normalizeText(value, 32).toLowerCase();
  if (decision === 'approve' || decision === 'approved' || decision === 'allow' || decision === 'allowed' || decision === 'yes') {
    return 'approve';
  }
  if (decision === 'reject' || decision === 'rejected' || decision === 'deny' || decision === 'denied' || decision === 'no') {
    return 'reject';
  }
  throw createSessionCommandError('invalid_approval_decision', 400);
}

function normalizeStopScope(value) {
  const scope = normalizeText(value, 32).toLowerCase();
  if (scope === 'run' || scope === 'session') return scope;
  throw createSessionCommandError('invalid_stop_scope', 400);
}

function normalizeSlashCommand(source) {
  if (hasPromptLikeField(source)) {
    throw createSessionCommandError('slash_command_must_not_carry_approval_id', 400);
  }
  const command = normalizeText(source.command || source.slash || source.name, 256);
  if (!command) throw createSessionCommandError('missing_slash_command', 400);
  if (!command.startsWith('/')) throw createSessionCommandError('invalid_slash_command', 400);
  const args = normalizeCommandArgs(source.args);
  const input = args ? `${command} ${args}` : command;
  return {
    input,
    appendNewline: true,
    command,
    args
  };
}

function normalizeMessageCommand(source) {
  if (hasPromptLikeField(source)) {
    throw createSessionCommandError('message_command_must_not_carry_approval_id', 400);
  }
  return {
    input: normalizeInputText(source.text || source.message || source.input, 'missing_message_text'),
    appendNewline: true
  };
}

function normalizeApprovalCommand(source) {
  const approvalId = normalizeText(source.approvalId || source.approval_id || source.promptId || source.prompt_id, 256);
  if (!approvalId) throw createSessionCommandError('missing_approval_id', 400);
  const decision = normalizeDecision(source.decision);
  const response = normalizeText(source.response || source.input || source.value, 256) || decision;
  return {
    input: response,
    appendNewline: true,
    approvalId,
    decision
  };
}

function normalizeStopCommand(source) {
  return {
    scope: normalizeStopScope(source.scope)
  };
}

function normalizeSessionCommandPayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const type = normalizeCommandType(source.type || source.commandType || source.command_type);
  if (!COMMAND_TYPES.includes(type)) {
    throw createSessionCommandError('invalid_session_command_type', 400);
  }
  const sessionId = normalizeText(source.sessionId || source.session_id || source.runId || source.run_id || source.sessionRef, 128);
  if (!sessionId) throw createSessionCommandError('missing_session_id', 400);
  const idempotencyKey = normalizeText(source.idempotencyKey || source.idempotency_key, 128);
  if (!idempotencyKey) throw createSessionCommandError('missing_idempotency_key', 400);
  const commandId = normalizeCommandId(source.commandId || source.command_id, idempotencyKey);
  const base = {
    type,
    sessionId,
    commandId,
    idempotencyKey
  };
  if (type === 'message') return { ...base, ...normalizeMessageCommand(source) };
  if (type === 'slash') return { ...base, ...normalizeSlashCommand(source) };
  if (type === 'approval_response') return { ...base, ...normalizeApprovalCommand(source) };
  return { ...base, ...normalizeStopCommand(source) };
}

function isSessionRef(value) {
  return SESSION_REF_PATTERN.test(String(value || '').trim());
}

function isNativeRunNotFound(error) {
  return String(error && error.code || '') === 'native_chat_run_not_found';
}

function isNativeRunInactive(error) {
  return String(error && error.code || '') === 'native_session_run_not_active';
}

function isHeadlessResumeProvider(provider) {
  return HEADLESS_RESUME_PROVIDERS.has(normalizeText(provider, 64).toLowerCase());
}

function buildAck(command, result = {}) {
  const cursor = Number(result.cursor);
  const ack = {
    accepted: true,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    type: command.type,
    sessionId: command.sessionId
  };
  if (result.runId) ack.runId = result.runId;
  if (result.sessionRef) ack.sessionRef = result.sessionRef;
  if (Number.isFinite(cursor) && cursor >= 0) ack.cursor = Math.floor(cursor);
  if (command.type === 'slash') ack.command = command.command;
  if (command.type === 'approval_response') {
    ack.approvalId = command.approvalId;
    ack.decision = command.decision;
  }
  if (command.type === 'stop') ack.scope = command.scope;
  return ack;
}

function getRunDescriptor(command, deps = {}) {
  const reader = typeof deps.getNativeChatRun === 'function'
    ? deps.getNativeChatRun
    : getNativeChatRun;
  const run = reader(command.sessionId);
  if (run) {
    return {
      runId: normalizeText(run.runId || command.sessionId, 160),
      provider: normalizeText(run.provider, 64).toLowerCase(),
      accountId: normalizeText(run.accountId, 96),
      sessionId: normalizeText(run.sessionId, 256),
      projectDirName: normalizeText(run.projectDirName, 512),
      projectPath: normalizeText(run.projectPath, 2048),
      interactiveCli: run.interactiveCli === true,
      completed: run.completed === true,
      inMemory: true
    };
  }

  const eventReader = typeof deps.readNativeSessionRunEvents === 'function'
    ? deps.readNativeSessionRunEvents
    : readNativeSessionRunEvents;
  try {
    const result = eventReader({
      runId: command.sessionId,
      cursor: 0,
      limit: 1,
      ...(deps.aiHomeDir ? { aiHomeDir: deps.aiHomeDir } : {})
    });
    if (!result) return null;
    return {
      runId: normalizeText(result.runId || command.sessionId, 160),
      provider: normalizeText(result.provider, 64).toLowerCase(),
      accountId: normalizeText(result.accountId, 96),
      sessionId: normalizeText(result.sessionId, 256),
      projectDirName: normalizeText(result.projectDirName, 512),
      projectPath: normalizeText(result.projectPath, 2048),
      interactiveCli: result.interactiveCli === true,
      completed: result.completed === true || normalizeText(result.status, 64) === 'completed',
      persisted: result.persisted === true
    };
  } catch (_error) {
    return null;
  }
}

function buildNativeResumePayload(command, descriptor) {
  if (!descriptor || !descriptor.provider) {
    throw createSessionCommandError('headless_session_run_not_found', 404);
  }
  if (!descriptor.completed) {
    throw createSessionCommandError('headless_session_run_still_running', 409);
  }
  if (!descriptor.sessionId) {
    throw createSessionCommandError('headless_session_id_unavailable', 409);
  }
  const payload = {
    provider: descriptor.provider,
    accountId: descriptor.accountId,
    prompt: command.input,
    projectPath: descriptor.projectPath,
    projectDirName: descriptor.projectDirName,
    sessionId: descriptor.sessionId
  };
  if (command.type === 'slash') {
    payload.prompt = '';
    payload.initialInput = command.input;
    payload.interactiveCli = true;
  }
  return payload;
}

function startNativeResume(command, descriptor, deps = {}) {
  const starter = typeof deps.startNativeDeviceSession === 'function'
    ? deps.startNativeDeviceSession
    : startNativeDeviceSession;
  return starter(buildNativeResumePayload(command, descriptor), {
    getProfileDir: deps.getProfileDir,
    resolveSessionAccountId: deps.resolveSessionAccountId,
    ensureSessionStoreLinks: deps.ensureSessionStoreLinks,
    accountRuntimeEventHub: deps.accountRuntimeEventHub,
    accountStateService: deps.accountStateService,
    registerNativeChatRun: deps.registerNativeChatRun,
    unregisterNativeChatRun: deps.unregisterNativeChatRun,
    aiHomeDir: deps.aiHomeDir,
    env: deps.env || process.env
  });
}

function buildResumeAck(command, descriptor, result = {}) {
  const stream = result && result.stream && typeof result.stream === 'object' ? result.stream : {};
  return {
    ...buildAck(command, {
      runId: result && result.runId,
      sessionRef: result && result.sessionId || descriptor.sessionId,
      cursor: stream.cursor
    }),
    resumed: true,
    resumedFromRunId: command.sessionId,
    provider: descriptor.provider,
    status: result && result.status || 'running'
  };
}

function commandAckKey(command) {
  return `${command.sessionId}\n${command.idempotencyKey}`;
}

function commandFingerprint(command) {
  return JSON.stringify({
    type: command.type,
    sessionId: command.sessionId,
    commandId: command.commandId,
    input: command.input || '',
    command: command.command || '',
    args: command.args || '',
    approvalId: command.approvalId || '',
    decision: command.decision || '',
    scope: command.scope || ''
  });
}

function getCachedSessionCommandAck(command) {
  const cached = sessionCommandAcks.get(commandAckKey(command));
  if (!cached) return null;
  if (cached.fingerprint !== commandFingerprint(command)) {
    throw createSessionCommandError('session_command_idempotency_conflict', 409);
  }
  if (cached.promise) {
    return cached.promise.then((ack) => ({
      ...cloneJson(ack),
      duplicate: true
    }));
  }
  return {
    ...cloneJson(cached.ack),
    duplicate: true
  };
}

function storePendingSessionCommandAck(command, promise) {
  const key = commandAckKey(command);
  const entry = {
    fingerprint: commandFingerprint(command),
    promise
  };
  sessionCommandAcks.set(key, entry);
  promise.then((ack) => {
    const current = sessionCommandAcks.get(key);
    if (current !== entry) return;
    sessionCommandAcks.set(key, {
      fingerprint: entry.fingerprint,
      ack: cloneJson(ack)
    });
  }, () => {
    if (sessionCommandAcks.get(key) === entry) sessionCommandAcks.delete(key);
  });
  return promise;
}

function clearSessionCommandAcks() {
  sessionCommandAcks.clear();
  sessionCommandQueues.clear();
}

function resolveSessionCommandSettleDelayMs(deps = {}) {
  if (Number.isFinite(deps.sessionCommandSettleDelayMs)) {
    return Math.max(0, Math.floor(deps.sessionCommandSettleDelayMs));
  }
  return SESSION_COMMAND_SETTLE_DELAY_MS;
}

function waitForSessionCommandSettle(deps = {}) {
  if (typeof deps.waitForSessionCommandSettle === 'function') {
    return Promise.resolve(deps.waitForSessionCommandSettle());
  }
  const delayMs = resolveSessionCommandSettleDelayMs(deps);
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

function enqueueSessionCommand(sessionId, task, deps = {}) {
  const previousTail = sessionCommandQueues.get(sessionId) || Promise.resolve();
  const runPromise = previousTail.catch(() => undefined).then(task);
  const settlePromise = runPromise.then(
    () => waitForSessionCommandSettle(deps),
    () => waitForSessionCommandSettle(deps)
  );
  let tailPromise;
  tailPromise = settlePromise.finally(() => {
    if (sessionCommandQueues.get(sessionId) === tailPromise) {
      sessionCommandQueues.delete(sessionId);
    }
  });
  sessionCommandQueues.set(sessionId, tailPromise);
  return runPromise;
}

function readRunCursor(runId, deps = {}) {
  const reader = typeof deps.readNativeSessionRunEvents === 'function'
    ? deps.readNativeSessionRunEvents
    : readNativeSessionRunEvents;
  try {
    const result = reader({
      runId,
      cursor: 0,
      limit: 1,
      ...(deps.aiHomeDir ? { aiHomeDir: deps.aiHomeDir } : {})
    });
    const cursor = Number(result && result.cursor);
    return Number.isFinite(cursor) && cursor >= 0 ? Math.floor(cursor) : undefined;
  } catch (_error) {
    return undefined;
  }
}

async function loadSnapshot(deps = {}) {
  if (typeof deps.loadProjectsSnapshot === 'function') {
    return deps.loadProjectsSnapshot();
  }
  return deps.projectSnapshot || { projects: [] };
}

async function writeSessionRefCommand(command, deps = {}) {
  const snapshot = await loadSnapshot(deps);
  const writer = typeof deps.writeDeviceSessionInput === 'function'
    ? deps.writeDeviceSessionInput
    : writeDeviceSessionInput;
  const result = writer(snapshot, {
    sessionRef: command.sessionId,
    input: command.input,
    appendNewline: command.appendNewline,
    ...(command.approvalId ? { promptId: command.approvalId } : {})
  }, {
    findNativeChatRunBySession: deps.findNativeChatRunBySession,
    unregisterNativeChatRun: deps.unregisterNativeChatRun
  });
  return buildAck(command, {
    sessionRef: command.sessionId,
    cursor: result && result.cursor
  });
}

async function executeInputCommand(command, deps = {}) {
  const descriptor = getRunDescriptor(command, deps);
  if (descriptor && isHeadlessResumeProvider(descriptor.provider) && descriptor.interactiveCli !== true) {
    if (command.type === 'approval_response') {
      throw createSessionCommandError('headless_session_approval_unsupported', 400);
    }
    if (command.type === 'message' || command.type === 'slash') {
      const result = startNativeResume(command, descriptor, deps);
      return buildResumeAck(command, descriptor, result);
    }
  }

  const writer = typeof deps.writeNativeSessionRunInput === 'function'
    ? deps.writeNativeSessionRunInput
    : writeNativeSessionRunInput;
  try {
    const result = await writer({
      runId: command.sessionId,
      input: command.input,
      appendNewline: command.appendNewline,
      ...(command.approvalId ? { promptId: command.approvalId } : {})
    });
    return buildAck(command, {
      runId: result && result.runId || command.sessionId,
      cursor: readRunCursor(result && result.runId || command.sessionId, deps)
    });
  } catch (error) {
    if (
      isNativeRunInactive(error)
      && descriptor
      && isHeadlessResumeProvider(descriptor.provider)
      && descriptor.interactiveCli !== true
      && (command.type === 'message' || command.type === 'slash')
    ) {
      const result = startNativeResume(command, { ...descriptor, completed: true }, deps);
      return buildResumeAck(command, descriptor, result);
    }
    if (!isNativeRunNotFound(error) || !isSessionRef(command.sessionId)) throw error;
    return writeSessionRefCommand(command, deps);
  }
}

async function executeStopCommand(command, deps = {}) {
  const aborter = typeof deps.abortNativeSessionRun === 'function'
    ? deps.abortNativeSessionRun
    : abortNativeSessionRun;
  const result = await aborter({ runId: command.sessionId }, {
    unregisterNativeChatRun: deps.unregisterNativeChatRun,
    ...(deps.aiHomeDir ? { aiHomeDir: deps.aiHomeDir } : {})
  });
  return buildAck(command, {
    runId: result && result.runId || command.sessionId,
    cursor: readRunCursor(result && result.runId || command.sessionId, deps)
  });
}

async function executeRemoteDevelopmentSessionCommand(payload = {}, deps = {}) {
  const command = normalizeSessionCommandPayload(payload);
  const cached = getCachedSessionCommandAck(command);
  if (cached) return cached;
  const promise = enqueueSessionCommand(command.sessionId, async () => {
    return command.type === 'stop'
      ? await executeStopCommand(command, deps)
      : await executeInputCommand(command, deps);
  }, deps);
  return storePendingSessionCommandAck(command, promise);
}

function buildForwardedSessionCommandPayload(payload = {}) {
  const command = normalizeSessionCommandPayload(payload);
  const forwarded = {
    type: command.type,
    sessionId: command.sessionId,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey
  };
  if (command.type === 'message') {
    forwarded.text = command.input;
  } else if (command.type === 'slash') {
    forwarded.command = command.command;
    if (command.args) forwarded.args = command.args;
  } else if (command.type === 'approval_response') {
    forwarded.approvalId = command.approvalId;
    forwarded.decision = command.decision;
    if (command.input !== command.decision) forwarded.response = command.input;
  } else if (command.type === 'stop') {
    forwarded.scope = command.scope;
  }
  return forwarded;
}

module.exports = {
  COMMAND_TYPES,
  buildForwardedSessionCommandPayload,
  clearSessionCommandAcks,
  executeRemoteDevelopmentSessionCommand,
  normalizeSessionCommandPayload
};
