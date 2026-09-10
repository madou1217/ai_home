'use strict';

const crypto = require('node:crypto');
const { withTransaction } = require('./database');
const { ChatRuntimeError } = require('./contracts');
const { buildChatHistoryPrefix, messageSubmission } = require('./chat-history-prefix');
const { isChatSession } = require('./chat-harness-policy');

// DSH's durable seed/lineage, adapted to AIH's single account and event stores.
// Seed + child + attachment ownership commit together before any native launch.
class SessionBranchRepository {
  constructor(store) { this.store = store; this.context = store.context; }

  create(command) {
    return withTransaction(this.context.db, () => {
      const source = this.store.sessions.require(command.sessionId);
      if (!isChatSession(source)) throw new ChatRuntimeError('chat_branch_mode_unsupported', 422);
      const sessionId = `session-${crypto.createHash('sha256').update(command.commandId).digest('hex')}`;
      const existing = this.store.getSession(sessionId);
      if (existing) {
        if (existing.policy.lineage?.parentSessionId !== source.sessionId
          || existing.policy.lineage?.commandId !== command.commandId) {
          throw new ChatRuntimeError('chat_branch_identity_conflict', 409);
        }
        return existing;
      }
      if (source.state !== 'idle' || source.activeTurn) throw new ChatRuntimeError('chat_branch_source_busy', 409);
      const regenerate = command.type === 'turn.regenerate';
      const prefix = buildChatHistoryPrefix(this.store, source, command.payload.sourceItemId, regenerate);
      const { legacySessionId: _legacy, lineage: _lineage, archived: _archived, contextState: _context, ...policy } = source.policy;
      const child = this.store.sessions.createInTransaction({
        sessionId, provider: source.provider, executionAccountRef: source.executionAccountRef,
        projectPath: '', capabilitySnapshot: source.capabilitySnapshot, policy: { ...policy, contextState: {},
          title: `${source.policy.title || '对话'} · ${regenerate ? '重新生成' : '分支'}`,
          lineage: { parentSessionId: source.sessionId, sourceItemId: command.payload.sourceItemId,
            operation: command.type, commandId: command.commandId } }
      });
      const messageSubmissions = {};
      const drafts = prefix.items.map((original, index) => {
        const id = `${sessionId}-seed-${index}`;
        if (original.kind === 'message' && original.detail.role === 'user') {
          messageSubmissions[id] = this.cloneSubmission(source.sessionId, sessionId,
            messageSubmission(this.store, source, original));
        }
        const { turnId: _turn, ...item } = original;
        return { eventId: `${id}-event`, type: 'timeline.item.completed', at: original.updatedAt || original.createdAt,
          source: { provider: source.provider, runtimeId: 'aih:history-seed' },
          payload: { item: { ...item, id, detail: { ...item.detail, inherited: true } } } };
      });
      // Use the same IDs in the native seed and canonical projection. Native
      // history reload then updates existing messages instead of duplicating them.
      const ids = new Map(prefix.items.map((item, index) => [item.id, `${sessionId}-seed-${index}`]));
      const responseItems = prefix.responseItems.map((item) => ({ ...item, id: ids.get(item.id) }));
      const submission = prefix.submission ? this.cloneSubmission(source.sessionId, sessionId, prefix.submission) : null;
      this.context.db.prepare(`INSERT INTO chat_runtime_history_seeds
        (session_id, response_items_json, message_submissions_json, regeneration_json) VALUES (?, ?, ?, ?)`)
        .run(sessionId, JSON.stringify(responseItems), JSON.stringify(messageSubmissions), JSON.stringify(submission));
      this.store.timelineImports.importInTransaction(sessionId, drafts);
      this.context.db.prepare('UPDATE chat_runtime_sessions SET updated_at = ? WHERE session_id = ?')
        .run(this.context.clock(), sessionId);
      return this.store.sessions.require(child.sessionId);
    });
  }

  cloneSubmission(sourceId, childId, payload) {
    const attachmentIds = this.store.attachments.cloneInTransaction(sourceId, childId, payload.attachmentIds || []);
    return { ...payload, ...(attachmentIds.length ? { attachmentIds } : {}) };
  }

  read(sessionId) {
    const row = this.context.db.prepare('SELECT * FROM chat_runtime_history_seeds WHERE session_id = ?').get(sessionId);
    return row ? { responseItems: JSON.parse(row.response_items_json),
      messageSubmissions: JSON.parse(row.message_submissions_json), regeneration: JSON.parse(row.regeneration_json) } : null;
  }

  readMessageSubmission(sessionId, itemId) { return this.read(sessionId)?.messageSubmissions[itemId]; }
}

module.exports = { SessionBranchRepository };
