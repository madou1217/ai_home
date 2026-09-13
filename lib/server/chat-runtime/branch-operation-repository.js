'use strict';

const { isDeepStrictEqual } = require('node:util');
const { ChatRuntimeError } = require('./contracts');
const { withTransaction } = require('./database');

const NEXT = new Map([
  ['prepared', new Set(['fork_pending'])],
  ['fork_pending', new Set(['forked'])],
  ['forked', new Set(['inject_pending', 'ready'])],
  ['inject_pending', new Set(['ready'])]
]);

// Durable checkpoints bridge native I/O and the AIH transaction. A pending
// operation is recoverable only from positive provider evidence, never by
// blindly replaying a create/inject call after a process or socket failure.
class BranchOperationRepository {
  constructor(store) { this.store = store; this.context = store.context; }

  prepare(command, plan) {
    return withTransaction(this.context.db, () => {
      const accepted = this.store.getCommand(command.commandId);
      const source = this.store.sessions.require(command.sessionId);
      if (!accepted || accepted.sessionId !== command.sessionId || accepted.type !== command.type
        || !['session.fork', 'turn.regenerate'].includes(command.type)
        || !isDeepStrictEqual(accepted.payload, command.payload)) throw identityConflict();
      if (!plan || !Array.isArray(plan.items) || plan.threadId !== source.runtimeBinding.nativeSessionId
        || plan.sourceItemId !== command.payload.sourceItemId) throw identityConflict();
      const hasLast = typeof plan.lastTurnId === 'string' && Boolean(plan.lastTurnId);
      const hasBefore = typeof plan.beforeTurnId === 'string' && Boolean(plan.beforeTurnId);
      if (hasLast === hasBefore || (hasLast && plan.items.length)) throw identityConflict();
      if (plan.forkThreadId && plan.forkThreadId !== plan.threadId) {
        const lineage = source.policy.lineage;
        const parent = lineage && this.read(lineage.parentSessionId, lineage.commandId);
        if (!parent || parent.receipt?.threadId !== plan.threadId
          || (parent.plan.forkThreadId || parent.plan.threadId) !== plan.forkThreadId
          || parent.plan.beforeTurnId !== plan.beforeTurnId
          || parent.executionAccountRef !== source.executionAccountRef) throw identityConflict();
      }
      const existing = this.read(command.sessionId, command.commandId);
      if (existing) {
        this.requireSource(existing);
        if (!isDeepStrictEqual(existing.plan, plan)) throw identityConflict();
        return existing;
      }
      if (accepted.status !== 'accepted' || source.state !== 'idle' || source.activeTurn) {
        throw new ChatRuntimeError('chat_branch_source_busy', 409);
      }
      this.context.db.prepare(`INSERT INTO chat_runtime_branch_operations
        (command_id, session_id, execution_account_ref, source_native_thread_id, plan_json, state, updated_at)
        VALUES (?, ?, ?, ?, ?, 'prepared', ?)`).run(command.commandId, source.sessionId,
        source.executionAccountRef, plan.threadId, JSON.stringify(plan), this.context.clock());
      return this.read(source.sessionId, command.commandId);
    });
  }

  read(sessionId, commandId) {
    const row = this.context.db.prepare(`SELECT * FROM chat_runtime_branch_operations
      WHERE session_id = ? AND command_id = ?`).get(sessionId, commandId);
    return row ? { sessionId: row.session_id, commandId: row.command_id,
      executionAccountRef: row.execution_account_ref, sourceThreadId: row.source_native_thread_id,
      plan: JSON.parse(row.plan_json), state: row.state,
      receipt: row.native_receipt_json ? JSON.parse(row.native_receipt_json) : null } : null;
  }

  advance(sessionId, commandId, from, to, receipt) {
    return withTransaction(this.context.db, () => {
      const operation = this.read(sessionId, commandId);
      if (!operation) throw identityConflict();
      this.requireSource(operation);
      if (operation.state !== from || !NEXT.get(from)?.has(to)) {
        throw new ChatRuntimeError('chat_branch_operation_stale', 409);
      }
      const nextReceipt = receipt === undefined ? operation.receipt : receipt;
      if (to === 'fork_pending' && nextReceipt) throw identityConflict();
      if (to !== 'fork_pending' && (!nextReceipt || typeof nextReceipt.threadId !== 'string'
        || !nextReceipt.threadId || nextReceipt.threadId === operation.sourceThreadId)) throw identityConflict();
      if (nextReceipt && nextReceipt.sourceThreadId !== operation.sourceThreadId) throw identityConflict();
      if (operation.receipt && !isDeepStrictEqual(operation.receipt, nextReceipt)) throw identityConflict();
      if (to === 'inject_pending' && !operation.plan.items.length) {
        throw new ChatRuntimeError('chat_branch_injection_unexpected', 409);
      }
      if (to === 'ready' && from === 'forked' && operation.plan.items.length) {
        throw new ChatRuntimeError('chat_branch_injection_required', 409);
      }
      this.context.db.prepare(`UPDATE chat_runtime_branch_operations SET
        state = ?, native_receipt_json = ?, updated_at = ? WHERE session_id = ? AND command_id = ? AND state = ?`)
        .run(to, nextReceipt ? JSON.stringify(nextReceipt) : null, this.context.clock(), sessionId, commandId, from);
      return this.read(sessionId, commandId);
    });
  }

  requireSource(operation) {
    const source = this.store.sessions.require(operation.sessionId);
    if (source.executionAccountRef !== operation.executionAccountRef
      || source.runtimeBinding.nativeSessionId !== operation.sourceThreadId) throw identityConflict();
  }
}

function identityConflict() { return new ChatRuntimeError('chat_branch_operation_identity_conflict', 409); }
module.exports = { BranchOperationRepository };
