'use strict';

const { ChatRuntimeError } = require('./contracts');
const { nativeHistoryParams } = require('./codex-native-history-policy');
const { codexForkSource, findCodexForkReceipt, readCodexInjectionReceipt } = require('./codex-fork-receipt');

// Only this adapter knows the fork/inject protocol or local rollout format.
// getRuntimeHome must return the current connection's verified account home;
// the receipt reader independently verifies its hash before reading any file.
class CodexBranchOperationPort {
  constructor({ client, getRuntimeHome, model }) {
    this.client = client;
    this.getRuntimeHome = getRuntimeHome;
    this.model = model;
  }

  async fork(operation) {
    const plan = operation.plan;
    if (Boolean(plan.lastTurnId) === Boolean(plan.beforeTurnId)) {
      throw new ChatRuntimeError('codex_fork_boundary_required', 422);
    }
    const response = await this.client.request('thread/fork', nativeHistoryParams({
      threadId: plan.forkThreadId || operation.sourceThreadId,
      ...(plan.lastTurnId ? { lastTurnId: plan.lastTurnId } : { beforeTurnId: plan.beforeTurnId }),
      ...(this.model ? { model: this.model } : {}),
      excludeTurns: true, deferGoalContinuation: true, threadSource: codexForkSource(operation)
    }));
    const thread = response?.thread;
    if (!thread?.id || thread.id === operation.sourceThreadId
      || thread.forkedFromId !== (plan.forkThreadId || operation.sourceThreadId) || thread.threadSource !== codexForkSource(operation)) {
      throw new ChatRuntimeError('codex_fork_receipt_identity_conflict', 409);
    }
    return this.receipt(operation, { threadId: thread.id, sourceThreadId: thread.forkedFromId, threadSource: thread.threadSource });
  }

  async recoverFork(operation) {
    const receipt = await findCodexForkReceipt(await this.receiptOptions(operation));
    return receipt ? this.receipt(operation, receipt) : null;
  }

  async inject(operation) {
    // A recovered fork may no longer be loaded. Resume only the identity
    // already confirmed by its receipt, never candidate user threads.
    const response = await this.client.request('thread/resume', nativeHistoryParams({
      threadId: operation.receipt.threadId, excludeTurns: true,
      ...(this.model ? { model: this.model } : {})
    }));
    if (response?.thread?.id !== operation.receipt.threadId) {
      throw new ChatRuntimeError('codex_fork_receipt_identity_conflict', 409);
    }
    if (response.thread.status?.type === 'active') throw new ChatRuntimeError('codex_fork_child_busy', 409);
    await this.client.request('thread/inject_items', {
      threadId: operation.receipt.threadId, items: operation.plan.items
    });
  }

  async recoverInjection(operation) {
    return readCodexInjectionReceipt({ ...await this.receiptOptions(operation),
      threadId: operation.receipt.threadId, items: operation.plan.items });
  }

  async receiptOptions(operation) {
    return { ...await this.getRuntimeHome(), sourceThreadId: operation.plan.forkThreadId || operation.sourceThreadId,
      threadSource: codexForkSource(operation) };
  }

  receipt(operation, receipt) {
    return { ...receipt, sourceThreadId: operation.sourceThreadId,
      ...(operation.plan.forkThreadId ? { forkParentThreadId: operation.plan.forkThreadId } : {}) };
  }
}

module.exports = { CodexBranchOperationPort };
