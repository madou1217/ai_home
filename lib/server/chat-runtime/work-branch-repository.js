'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { ChatRuntimeError } = require('./contracts');
const { withTransaction } = require('./database');
const { projectTimeline } = require('./timeline-projector');
const { messageSubmission } = require('./chat-history-prefix');

// Native response items remain private; the public child timeline keeps exact
// native IDs so subsequent history imports update rather than duplicate items.
class WorkBranchRepository {
  constructor(store) { this.store = store; this.context = store.context; }

  capture(command) {
    const source = this.store.sessions.require(command.sessionId);
    if (source.state !== 'idle' || source.activeTurn) throw new ChatRuntimeError('chat_branch_source_busy', 409);
    const timeline = projectTimeline(this.store.events.listAll(source.sessionId));
    const cut = timeline.findIndex((item) => item.id === command.payload.sourceItemId);
    const target = timeline[cut];
    if (!target || target.kind !== 'message' || target.status !== 'completed') {
      throw new ChatRuntimeError('chat_branch_message_unavailable', 409);
    }
    const regenerate = command.type === 'turn.regenerate';
    const userIndex = regenerate ? timeline.slice(0, cut).findLastIndex((item) => item.kind === 'message'
      && item.detail.role === 'user' && item.detail.phase !== 'interaction_answer') : -1;
    if (regenerate && (target.detail.role !== 'assistant' || userIndex < 0)) {
      throw new ChatRuntimeError('chat_regenerate_input_missing', 409);
    }
    const regeneration = regenerate ? messageSubmission(this.store, source, timeline[userIndex]) : null;
    const items = timeline.slice(0, regenerate ? userIndex : cut + 1);
    const submissions = Object.fromEntries(items.filter((item) => item.kind === 'message'
      && item.detail.role === 'user' && item.detail.phase !== 'interaction_answer')
      .map((item) => [item.id, messageSubmission(this.store, source, item)]));
    for (const submission of Object.values(submissions)) {
      this.store.attachments.resolvePaths(source.sessionId, submission.attachmentIds || []);
    }
    if (regeneration) this.store.attachments.resolvePaths(source.sessionId, regeneration.attachmentIds || []);
    const itemIds = new Set(items.map((item) => item.id));
    const interactions = this.context.db.prepare(`SELECT interaction_id FROM chat_runtime_interactions
      WHERE session_id = ? ORDER BY created_at, interaction_id`).all(source.sessionId)
      .map((row) => this.store.interactions.get(row.interaction_id))
      .filter((interaction) => itemIds.has(interaction.itemId)
        || itemIds.has(`interaction-answer:${interaction.interactionId}:${interaction.revision}`));
    if (interactions.some((interaction) => ['pending', 'resolving'].includes(interaction.state))) {
      throw new ChatRuntimeError('chat_branch_interaction_pending', 409);
    }
    return { items, submissions, interactions, regeneration, anchorItemId: regenerate ? timeline[userIndex].id : target.id,
      projectPath: source.projectPath, policy: source.policy,
      capabilitySnapshot: source.capabilitySnapshot, runtimeBinding: source.runtimeBinding };
  }

  existing(command) {
    const child = this.store.getSession(childId(command));
    if (!child) return null;
    const source = this.store.sessions.require(command.sessionId);
    if (child.policy.lineage?.commandId !== command.commandId
      || child.policy.lineage?.parentSessionId !== source.sessionId
      || child.policy.lineage?.sourceItemId !== command.payload.sourceItemId
      || child.policy.lineage?.operation !== command.type
      || child.executionAccountRef !== source.executionAccountRef || child.provider !== source.provider) {
      throw new ChatRuntimeError('chat_branch_identity_conflict', 409);
    }
    return child;
  }

  commit(command) {
    return withTransaction(this.context.db, () => {
      const existing = this.existing(command);
      if (existing) return existing;
      const operation = this.store.branchOperations.read(command.sessionId, command.commandId);
      if (!operation || operation.state !== 'ready' || !operation.plan.projection) {
        throw new ChatRuntimeError('chat_branch_operation_not_ready', 409);
      }
      this.store.branchOperations.requireSource(operation);
      const accepted = this.store.getCommand(command.commandId);
      if (accepted?.sessionId !== command.sessionId || accepted.type !== command.type
        || !isDeepStrictEqual(accepted.payload, command.payload)) {
        throw new ChatRuntimeError('chat_branch_operation_identity_conflict', 409);
      }
      const source = this.store.sessions.require(command.sessionId);
      const { projection } = operation.plan;
      const { lineage: _lineage, contextState: _context, queueControl: _queue,
        legacySessionId: _legacy, archived: _archived, ...policy } = projection.policy;
      const sessionId = childId(command);
      this.store.sessions.createInTransaction({ sessionId, provider: source.provider,
        executionAccountRef: operation.executionAccountRef, projectPath: projection.projectPath,
        capabilitySnapshot: projection.capabilitySnapshot,
        runtimeBinding: { ...projection.runtimeBinding, nativeSessionId: operation.receipt.threadId },
        policy: { ...policy, contextState: {}, title: `${policy.title || '工作会话'} · ${command.type === 'turn.regenerate' ? '重新生成' : '分支'}`,
          lineage: { parentSessionId: source.sessionId, sourceItemId: command.payload.sourceItemId,
            operation: command.type, commandId: command.commandId } }
      });
      const submissions = {};
      for (const [itemId, input] of Object.entries(projection.submissions)) {
        submissions[itemId] = this.store.branches.cloneSubmission(source.sessionId, sessionId, input);
      }
      const regeneration = projection.regeneration
        ? this.store.branches.cloneSubmission(source.sessionId, sessionId, projection.regeneration) : null;
      this.context.db.prepare(`INSERT INTO chat_runtime_history_seeds
        (session_id, response_items_json, message_submissions_json, regeneration_json) VALUES (?, '[]', ?, ?)`)
        .run(sessionId, JSON.stringify(submissions), JSON.stringify(regeneration));
      const interactionIds = this.copyInteractions(projection.interactions || [], sessionId, source.provider);
      this.store.timelineImports.importInTransaction(sessionId, projection.items.map((item, index) => ({
        eventId: `${sessionId}-inherited-${index}`, type: 'timeline.item.completed',
        at: item.updatedAt || item.createdAt, ...(item.turnId ? { turnId: item.turnId } : {}),
        source: { provider: source.provider, runtimeId: 'aih:native-branch' },
        payload: { item: { ...item, detail: { ...item.detail, inherited: true,
          ...(interactionIds.has(item.detail.interactionId)
            ? { interactionId: interactionIds.get(item.detail.interactionId) } : {}) } } }
      })));
      this.copyNativeEvidence(operation, sessionId);
      this.context.db.prepare('UPDATE chat_runtime_sessions SET updated_at = ? WHERE session_id = ?')
        .run(this.context.clock(), sessionId);
      return this.store.sessions.require(sessionId);
    });
  }

  copyInteractions(interactions, child, provider) {
    const ids = new Map();
    for (const original of interactions) {
      if (['pending', 'resolving'].includes(original.state)) throw new ChatRuntimeError('chat_branch_interaction_pending', 409);
      const interactionId = `${child}-interaction-${ids.size}`;
      const interaction = { ...original, sessionId: child, interactionId };
      ids.set(original.interactionId, interactionId);
      this.context.db.prepare(`INSERT INTO chat_runtime_interactions
        (interaction_id, session_id, item_id, kind, revision, payload_json, state, resolution_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(interactionId, child, interaction.itemId,
        interaction.kind, interaction.revision, JSON.stringify(interaction.payload), interaction.state,
        JSON.stringify(interaction.resolution || null), interaction.createdAt, interaction.updatedAt);
      this.store.events.appendInTransaction(child, { type: 'interaction.resolved', itemId: interaction.itemId,
        source: { provider, runtimeId: 'aih:native-branch' }, payload: { interaction } }, { measureTurn: false });
    }
    return ids;
  }

  copyNativeEvidence(operation, child) {
    const { nativeTurns } = operation.plan;
    if (!Array.isArray(nativeTurns)) throw new ChatRuntimeError('chat_branch_native_evidence_required', 409);
    for (const turn of nativeTurns) {
      for (const item of turn.items) this.store.nativeResponseItems.recordInTransaction(child,
        { threadId: operation.receipt.threadId, turnId: turn.id, item });
      for (const entry of turn.threadItems || []) this.store.nativeThreadItems.recordInTransaction(child,
        { threadId: operation.receipt.threadId, turnId: turn.id, ...entry });
      this.context.db.prepare(`INSERT INTO chat_runtime_native_history_coverage
        (session_id, native_thread_id, native_turn_id, state) VALUES (?, ?, ?, ?)`)
        .run(child, operation.receipt.threadId, turn.id, turn.coverage);
    }
  }
}

function childId(command) { return `session-${crypto.createHash('sha256').update(command.commandId).digest('hex')}`; }
module.exports = { WorkBranchRepository };
