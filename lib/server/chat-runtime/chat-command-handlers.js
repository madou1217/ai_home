'use strict';

const { ChatRuntimeError } = require('./contracts');

function createGenericCommandHandlers(options) {
  return Object.freeze({
    'session.policy.set': setSessionPolicy,
    'queue.add': addQueueItem,
    'queue.edit': editQueueItem,
    'queue.remove': removeQueueItem,
    'queue.move': moveQueueItem,
    'queue.dispatch': (context) => options.queueLifecycle.dispatch(context)
  });
}

function setSessionPolicy({ sessionId, command, store }) {
  const key = requiredText(command.payload.key, 'chat_session_policy_key_required');
  if (!Object.hasOwn(command.payload, 'value')) {
    throw new ChatRuntimeError('chat_session_policy_value_required', 422);
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
