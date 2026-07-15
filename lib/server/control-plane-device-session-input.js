'use strict';

const {
  resolveDeviceSession
} = require('./control-plane-device-sessions');
const {
  findNativeChatRunBySession,
  unregisterNativeChatRun
} = require('./native-chat-run-store');

const MAX_SESSION_INPUT_LENGTH = 64 * 1024;

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function createSessionInputError(code, statusCode = 400) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeSessionInputPayload(payload = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const input = String(source.input == null ? '' : source.input);
  if (!input) throw createSessionInputError('session_input_empty', 400);
  if (input.length > MAX_SESSION_INPUT_LENGTH) {
    throw createSessionInputError('session_input_too_large', 413);
  }
  return {
    sessionRef: normalizeText(source.sessionRef, 96),
    input,
    appendNewline: source.appendNewline !== false,
    promptId: normalizeText(source.promptId, 256)
  };
}

function resolveSessionInputRun(resolvedSession, deps = {}) {
  const params = resolvedSession && resolvedSession.readerParams;
  const finder = typeof deps.findNativeChatRunBySession === 'function'
    ? deps.findNativeChatRunBySession
    : findNativeChatRunBySession;
  return finder({
    provider: params && params.provider,
    sessionId: params && params.sessionId,
    projectDirName: params && params.projectDirName
  });
}

function buildWriteOptions(input) {
  return input.promptId
    ? { appendNewline: input.appendNewline, promptId: input.promptId }
    : { appendNewline: input.appendNewline };
}

function writeDeviceSessionInput(projectSnapshot, payload, deps = {}) {
  const input = normalizeSessionInputPayload(payload);
  const resolved = resolveDeviceSession(projectSnapshot, input.sessionRef);
  if (!resolved) {
    throw createSessionInputError('control_plane_device_session_not_found', 404);
  }
  const run = resolveSessionInputRun(resolved, deps);
  if (!run || typeof run.writeInput !== 'function') {
    throw createSessionInputError('native_chat_run_not_found', 409);
  }
  try {
    run.writeInput(input.input, buildWriteOptions(input));
  } catch (error) {
    const code = String((error && error.code) || 'native_chat_input_failed');
    if (code === 'native_session_run_not_active') {
      const unregister = typeof deps.unregisterNativeChatRun === 'function'
        ? deps.unregisterNativeChatRun
        : unregisterNativeChatRun;
      unregister(run.runId);
    }
    throw createSessionInputError(code, code === 'native_session_run_not_active' ? 409 : 400);
  }
  return {
    session: resolved.session,
    accepted: true,
    appendNewline: input.appendNewline,
    promptId: input.promptId
  };
}

module.exports = {
  MAX_SESSION_INPUT_LENGTH,
  normalizeSessionInputPayload,
  writeDeviceSessionInput
};
