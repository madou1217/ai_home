'use strict';

// Codex records raw user input before emitting its UserMessageItem. The raw
// metadata distinguishes user input from environment/context user-role items.
// Pair only one uninterrupted candidate in the exact thread/turn notification
// stream. Never infer identity from message text or history array position.
class CodexUserMessageLink {
  constructor() { this.pending = new Map(); }

  reset(threadId, turnId) { this.pending.delete(JSON.stringify([threadId, turnId])); }

  observe(message) {
    const { threadId, turnId, item } = message.params || {};
    const key = JSON.stringify([threadId, turnId]);
    if (message.method === 'rawResponseItem/completed') {
      const kinds = item?.internal_chat_message_metadata_passthrough?.content_item_kinds;
      if (item?.type === 'message' && item.role === 'user' && item.id && Array.isArray(kinds)
        && kinds.length && kinds.every((kind) => typeof kind === 'string' && kind.startsWith('user.'))) {
        this.pending.set(key, this.pending.has(key) ? null : item.id);
      } else this.pending.delete(key);
    } else if (message.method === 'item/started' && item?.type === 'userMessage') {
      const rawMessageId = this.pending.get(key) || null;
      this.pending.delete(key);
      return rawMessageId;
    } else if (message.method === 'turn/completed' || message.method === 'turn/started') {
      this.pending.delete(key);
      if (message.params?.turn?.id) this.reset(threadId, message.params.turn.id);
    } else if (message.method !== 'item/completed' && item) {
      this.pending.delete(key);
    }
    return null;
  }
}

module.exports = { CodexUserMessageLink };
