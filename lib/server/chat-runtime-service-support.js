'use strict';

const crypto = require('node:crypto');

const { ChatRuntimeError } = require('./chat-runtime/contracts');

function createSessionDraft(input, store) {
  const provider = requiredText(input.provider, 'chat_session_provider_required');
  const executionAccountRef = requiredText(
    input.executionAccountRef,
    'chat_session_execution_account_required'
  );
  const sessionId = String(input.sessionId || '').trim() || allocateSessionId(store);
  return { ...input, sessionId, provider, executionAccountRef };
}

function createFreshSessionDraft(input, store) {
  return createSessionDraft({
    sessionId: input.sessionId,
    provider: input.provider,
    executionAccountRef: input.executionAccountRef,
    projectPath: input.projectPath,
    policy: input.policy
  }, store);
}

function allocateSessionId(store) {
  const factory = store.context && store.context.idFactory;
  return typeof factory === 'function'
    ? factory('session')
    : `session-${crypto.randomUUID()}`;
}

function requireSession(store, sessionId) {
  const session = store.getSession(sessionId);
  if (!session) throw new ChatRuntimeError('chat_session_not_found', 404);
  return session;
}

function normalizeCursor(value) {
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

function retainedFirstSeq(firstSeq, throughSeq, limit) {
  if (throughSeq === 0) return 1;
  return Math.max(Number(firstSeq) || 1, throughSeq - limit + 1);
}

/** 重放事件是否从 after+1 起逐条连续（历史压缩会删行，留下序列空洞）。 */
function isContiguousFrom(after, events) {
  let expected = after + 1;
  for (const event of events) {
    if (Number(event && event.seq) !== expected) return false;
    expected += 1;
  }
  return true;
}

function boundedLimit(value, fallback) {
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000) : fallback;
}

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new ChatRuntimeError(code);
  return text;
}

module.exports = {
  boundedLimit,
  createFreshSessionDraft,
  createSessionDraft,
  isContiguousFrom,
  normalizeCursor,
  requireSession,
  retainedFirstSeq
};
