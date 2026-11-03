'use strict';

const { ChatRuntimeError } = require('./contracts');
const { readCodexHistoryResponse } = require('./codex-session-history');
const { planCodexHistoryFork } = require('./codex-history-fork-plan');
const { CodexBranchOperationPort } = require('./codex-branch-operation-port');
const { readCodexRolloutTurn } = require('./codex-rollout-turn');

class CodexWorkBranch {
  constructor(driver, options) { this.driver = driver; this.options = options; }

  async plan(command, projection) {
    const threadId = this.driver.nativeThreadId;
    if (!threadId || this.driver.active) throw new ChatRuntimeError('chat_branch_source_busy', 409);
    const response = await readCodexHistoryResponse(this.driver.client, threadId);
    const parentPlan = this.options.readInheritedBranchPlan?.();
    const inherited = retainBranchTurns(parentPlan?.branchHistory || []);
    response.thread.turns = retainBranchTurns(response.thread.turns);
    const nativeIds = new Set(response.thread.turns.map((turn) => turn.id));
    const turns = new Map(inherited.map((turn) => [turn.id, turn]));
    for (const turn of response.thread.turns) turns.set(turn.id, turn);
    response.thread.turns = [...turns.values()];
    for (const turn of response.thread.turns) {
      const live = this.options.readNativeThreadItems(turn.id);
      if (live.length && this.options.readNativeCoverage(turn.id) === 'complete') turn.items = live.map((entry) => entry.item);
    }
    const itemId = projection.anchorItemId;
    const excludeMessage = command.type === 'turn.regenerate';
    const target = response.thread.turns.find((turn) => turn.items.some((item) => item.id === itemId)
      || this.options.readNativeThreadItems(turn.id).some((entry) => entry.item.id === itemId));
    if (!target) throw new ChatRuntimeError('codex_fork_message_identity_unavailable', 409);
    let rawTurn = this.options.readNativeTurn(target.id);
    let coverage = this.options.readNativeCoverage(target.id);
    let disk;
    if (coverage !== 'complete') {
      const metadata = await this.driver.client.request('thread/read', { threadId });
      if (metadata?.thread?.id !== threadId) throw new ChatRuntimeError('codex_history_thread_mismatch', 409);
      disk = await readCodexRolloutTurn({ ...await this.runtimeHome(),
        rolloutPath: metadata.thread.path, threadId, turnId: target.id });
      rawTurn = disk.items;
      coverage = 'complete';
      // Live typed IDs stay useful after fork/resume disables raw events. Disk
      // boundaries now prove the raw half, independently from the stream gap.
      const live = this.options.readNativeThreadItems(target.id);
      if (live.length) target.items = live.map((entry) => entry.item);
    }
    const link = this.options.readNativeThreadItems(target.id).find((entry) => entry.item.id === itemId);
    const plan = planCodexHistoryFork({ response, threadId, itemId, rawTurn, coverage,
      rawMessageId: link?.rawMessageId || disk?.links.get(itemId), excludeMessage });
    if (!nativeIds.has(target.id)) {
      if (!parentPlan || parentPlan.beforeTurnId !== target.id) {
        throw new ChatRuntimeError('codex_fork_inherited_boundary_unavailable', 409);
      }
      // An injected partial turn has no native TurnStarted boundary in the
      // child. Reuse its immutable ancestor cut and inject only the new prefix.
      plan.forkThreadId = parentPlan.forkThreadId || parentPlan.threadId;
      plan.beforeTurnId = target.id;
      delete plan.lastTurnId;
      if (!plan.items.length && !excludeMessage) plan.items = rawTurn;
    }
    const cut = response.thread.turns.findIndex((turn) => turn.id === target.id);
    const branchHistory = response.thread.turns.slice(0, cut + 1).map((turn) => turn.id === target.id
      ? { ...turn, items: turn.items.slice(0, turn.items.findIndex((item) => item.id === itemId) + (excludeMessage ? 0 : 1)) }
      : turn);
    const nativeTurns = branchHistory.map((turn) => ({ id: turn.id,
      coverage: turn.id === target.id ? coverage : this.options.readNativeCoverage(turn.id) || 'incomplete',
      items: turn.id === target.id ? (plan.beforeTurnId ? plan.items : rawTurn) : this.options.readNativeTurn(turn.id),
      threadItems: this.options.readNativeThreadItems(turn.id).filter((entry) => turn.items.some((item) => item.id === entry.item.id))
        .map((entry) => ({ ...entry, rawMessageId: entry.rawMessageId || (turn.id === target.id ? disk?.links.get(entry.item.id) : null) || null })) }));
    return { ...plan, sourceItemId: command.payload.sourceItemId, projection, nativeTurns, branchHistory };
  }

  native() {
    return new CodexBranchOperationPort({ client: this.driver.client,
      getRuntimeHome: () => this.runtimeHome(), model: this.driver.getSessionPolicy()?.model });
  }

  async runtimeHome() {
    await this.driver.client.ensureConnected();
    const home = this.driver.client.getVerifiedRuntimeHome?.();
    if (!home) throw new ChatRuntimeError('codex_fork_runtime_home_unverified', 409);
    return home;
  }
}

// A native history can retain bookkeeping turns after a rollback or a
// superseding retry. They are not conversational evidence and must not leak
// into a child seed. Unknown statuses remain eligible; only explicit native
// rollback markers are filtered so this adapter never invents lifecycle state.
const DISCARDED_TURN_STATUSES = new Set([
  'stale', 'rollback', 'rolled_back', 'rolledback', 'reverted', 'reversed', 'superseded'
]);

function retainBranchTurns(turns) {
  return (Array.isArray(turns) ? turns : []).filter((turn) => !isDiscardedBranchTurn(turn));
}

function isDiscardedBranchTurn(turn) {
  if (!turn || typeof turn !== 'object' || Array.isArray(turn)) return true;
  const status = String(turn.status || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return DISCARDED_TURN_STATUSES.has(status)
    || turn.stale === true
    || turn.rollback === true
    || turn.rolledBack === true
    || turn.rolled_back === true
    || turn.superseded === true;
}

module.exports = { CodexWorkBranch, isDiscardedBranchTurn, retainBranchTurns };
