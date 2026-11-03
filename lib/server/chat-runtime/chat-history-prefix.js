'use strict';

const fs = require('node:fs');
const { ChatRuntimeError } = require('./contracts');
const { projectTimeline } = require('./timeline-projector');
const { sessionAttachmentTurnInput } = require('./chat-harness-policy');
const { guessAttachmentMimeType } = require('../chat-attachments');
const { assessHistoryPrefix, isSkippableNotice } = require('./history-reversibility');

// Pi createBranchedSession keeps the root-to-leaf path; DSH SessionStore.fork
// keeps an immutable seed. AIH cuts at the message, never rounds up to turn/end.
function buildChatHistoryPrefix(store, session, sourceItemId, regenerate = false) {
  const items = projectTimeline(store.events.listAll(session.sessionId));
  const index = items.findIndex((item) => item.id === sourceItemId);
  const target = items[index];
  if (!target || target.kind !== 'message' || target.status !== 'completed') {
    throw new ChatRuntimeError('chat_branch_message_unavailable', 409);
  }
  let cut = index + 1;
  let submission;
  if (regenerate) {
    if (target.detail.role !== 'assistant') throw new ChatRuntimeError('chat_regenerate_answer_required', 422);
    const userIndex = items.slice(0, index).findLastIndex((item) => item.kind === 'message' && item.detail.role === 'user');
    if (userIndex < 0) throw new ChatRuntimeError('chat_regenerate_input_missing', 409);
    cut = userIndex;
    submission = messageSubmission(store, session, items[userIndex]);
  }
  const prefix = items.slice(0, cut);
  const nativeItems = new Map(prefix.filter((item) => item.kind === 'reasoning').map((item) =>
    [item.id, store.nativeResponseItems.read(session.sessionId, item.id)]));
  const reversibility = assessHistoryPrefix(prefix, (id) => nativeItems.get(id));
  if (!reversibility.reversible) {
    throw new ChatRuntimeError('chat_branch_history_unsupported', 422, {
      kind: reversibility.kind,
      reason: reversibility.reason,
      ...(reversibility.itemId ? { itemId: reversibility.itemId } : {})
    });
  }
  const responseItems = prefix.flatMap((item) => {
    if (item.kind === 'message') return [responseMessage(store, session, item)];
    if (item.kind === 'reasoning') return [nativeItems.get(item.id)];
    if (item.kind === 'notice' && isSkippableNotice(item)) return [];
    // Work/tool history needs a separate lossless call/result contract. Never
    // silently turn an action, an image or a tool result into plain chat text.
    throw new ChatRuntimeError('chat_branch_history_unsupported', 422, { kind: item.kind });
  });
  return { items: prefix, responseItems, submission };
}

function messageSubmission(store, session, item) {
  const inherited = store.branches.readMessageSubmission(session.sessionId, item.id);
  const original = inherited || (item.turnId && store.failedTurns.findSubmission(session.sessionId, item.turnId)?.payload);
  if (original) return structuredClone(original);
  if (item.detail.inputs?.length) throw new ChatRuntimeError('chat_branch_attachment_source_missing', 409);
  return { content: item.content || '', ...(session.policy.model ? { model: session.policy.model } : {}),
    ...(session.policy.reasoningEffort ? { reasoningEffort: session.policy.reasoningEffort } : {}) };
}

function responseMessage(store, session, item) {
  if (item.detail.role !== 'user') return { type: 'message', id: item.id, role: item.detail.role,
    content: [{ type: 'output_text', text: item.content || '' }] };
  const submission = messageSubmission(store, session, item);
  const paths = store.resolveAttachmentPaths(session.sessionId, submission.attachmentIds || []);
  const turnInput = sessionAttachmentTurnInput(session, submission.content, paths, fs);
  return { type: 'message', id: item.id, role: 'user', content: [
    ...(turnInput.prompt ? [{ type: 'input_text', text: turnInput.prompt }] : []),
    ...turnInput.imagePaths.map((file) => ({ type: 'input_image', image_url:
      `data:${guessAttachmentMimeType(file)};base64,${fs.readFileSync(file).toString('base64')}` }))
  ] };
}

module.exports = { buildChatHistoryPrefix, messageSubmission };
