'use strict';

const { ChatRuntimeError } = require('./contracts');

function createGenericCommandHandlers(options) {
  return Object.freeze({
    'session.policy.set': setSessionPolicy,
    'session.goal.set': setSessionGoal,
    'session.goal.get': getSessionGoal,
    'session.goal.clear': clearSessionGoal,
    'queue.add': addQueueItem,
    'queue.edit': editQueueItem,
    'queue.remove': removeQueueItem,
    'queue.move': moveQueueItem,
    'queue.dispatch': (context) => options.queueLifecycle.dispatch(context)
  });
}

function setSessionGoal({ sessionId, command, store }) {
  const session = store.getSession(sessionId);
  if (!session) throw new ChatRuntimeError('chat_session_not_found', 404);
  if (session.state !== 'idle') throw new ChatRuntimeError('chat_goal_session_busy', 409);
  const now = Date.now();
  const existing = session.policy.contextState && session.policy.contextState.goal;
  const goal = {
    threadId: String(session.runtimeBinding && session.runtimeBinding.nativeSessionId || sessionId),
    objective: command.payload.objective,
    status: 'active',
    tokenBudget: command.payload.tokenBudget,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: existing && Number.isSafeInteger(existing.createdAt) ? existing.createdAt : now,
    updatedAt: now
  };
  return store.setGoal(sessionId, goal, { source: 'aih' });
}

function getSessionGoal({ sessionId, store }) {
  const session = store.getSession(sessionId);
  if (!session) throw new ChatRuntimeError('chat_session_not_found', 404);
  return { goal: session.policy.contextState && session.policy.contextState.goal || null };
}

function clearSessionGoal({ sessionId, store }) {
  const session = store.getSession(sessionId);
  if (!session) throw new ChatRuntimeError('chat_session_not_found', 404);
  if (session.state !== 'idle') throw new ChatRuntimeError('chat_goal_session_busy', 409);
  return store.clearGoal(sessionId);
}

function setSessionPolicy({ sessionId, command, store }) {
  const key = requiredText(command.payload.key, 'chat_session_policy_key_required');
  if (['workspaceMode', 'legacySessionId', 'archived', 'lineage', 'contextState', 'queueControl'].includes(key)) {
    throw new ChatRuntimeError('chat_session_policy_key_immutable', 409);
  }
  if (!Object.hasOwn(command.payload, 'value')) {
    throw new ChatRuntimeError('chat_session_policy_value_required', 422);
  }
  if (key === 'systemPrompt' || key === 'autoCompactPercent') {
    const current = store.getSession(sessionId);
    if (current.policy.workspaceMode !== 'chat') throw new ChatRuntimeError('chat_policy_mode_unsupported', 422);
    if (current.state !== 'idle') throw new ChatRuntimeError('chat_policy_turn_active', 409);
    if (key === 'systemPrompt' && (typeof command.payload.value !== 'string' || command.payload.value.length > 16000)) {
      throw new ChatRuntimeError('chat_system_prompt_invalid', 422);
    }
    if (key === 'autoCompactPercent' && (!Number.isInteger(command.payload.value)
      || command.payload.value < 50 || command.payload.value > 90)) {
      throw new ChatRuntimeError('chat_compaction_threshold_invalid', 422);
    }
  }
  const session = store.updatePolicy(sessionId, { [key]: command.payload.value });
  return { policy: session.policy };
}

function addQueueItem({ sessionId, command, store }) {
  return store.enqueue(sessionId, {
    commandId: command.commandId,
    policy: command.payload.policy,
    payload: { content: requiredContent(command.payload.content) }
  });
}

function editQueueItem({ command, store }) {
  return store.editQueueItem(command.payload.queueId, {
    content: requiredContent(command.payload.content)
  });
}

function removeQueueItem({ command, store }) {
  return store.removeQueueItem(command.payload.queueId);
}

function moveQueueItem({ command, store }) {
  return store.moveQueueItem(command.payload.queueId, command.payload.beforeQueueId);
}

function requiredContent(value) {
  return requiredText(value, 'chat_turn_content_required');
}

function requiredText(value, code) {
  const text = String(value || '').trim();
  if (!text) throw new ChatRuntimeError(code, 422);
  return text;
}

module.exports = { createGenericCommandHandlers };
