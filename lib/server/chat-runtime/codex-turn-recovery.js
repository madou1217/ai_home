'use strict';

const protocol = require('../codex-app-server-protocol');
const { ChatRuntimeError } = require('./contracts');
const {
  createActive,
  rejectActive,
  settleFromNative,
  text
} = require('./codex-session-driver-support');

const DEFAULT_CLEANUP_TIMEOUT_MS = 5000;

class CodexTurnRecovery {
  constructor(options) {
    Object.assign(this, options);
    this.cleanupTimeoutMs = positiveTimeout(options.cleanupTimeoutMs);
  }

  async recover(context = {}) {
    this.requireContext(context);
    if (this.getActive()) throw new ChatRuntimeError('chat_turn_already_active', 409);
    const threadId = text(this.getThreadId());
    if (!threadId) throw new ChatRuntimeError('codex_native_session_missing', 409);
    const active = createActive(context, '', '', '');
    active.approvalMode = this.getApprovalMode();
    active.nativeThreadId = threadId;
    active.nativeTurnId = text(context.activeTurn && context.activeTurn.nativeTurnId);
    active.clientUserMessageId = text(
      context.activeTurn && context.activeTurn.clientUserMessageId
    );
    this.setActive(active);
    try {
      const attached = await this.attach(active, context.activeTurn?.interruptRequested ? [] : context.pendingInteractions || []);
      // Reattach the same native turn, then reissue only cancellation. Never
      // turn a persisted stop into a fresh model request or drain the inbox.
      if (context.activeTurn?.interruptRequested && !active.settled) {
        const outcome = await this.interruptNativeTurn(active);
        if (outcome !== 'interrupted') {
          attached.done.catch(() => {});
          throw new ChatRuntimeError('codex_recovered_stop_failed', 502);
        }
      }
      return attached;
    } catch (error) {
      const nativeCleanup = await this.abandon(active, error);
      if (error && typeof error === 'object') error.nativeCleanup = nativeCleanup;
      throw error;
    }
  }

  async abandon(active, reason) {
    const nativeCleanup = await this.interruptNativeTurn(active);
    this.bridge.cancelExpectedReplays();
    this.cleanup(active);
    rejectActive(active, reason);
    active.done.catch(() => {});
    return nativeCleanup;
  }

  async interruptNativeTurn(active) {
    if (!active.nativeTurnId) return 'unknown';
    try {
      await withTimeout(
        this.client.request('turn/interrupt', protocol.buildTurnInterruptParams({
          threadId: active.nativeThreadId,
          turnId: active.nativeTurnId
        })),
        this.cleanupTimeoutMs
      );
      return 'interrupted';
    } catch (error) {
      return error && error.code === 'codex_recovery_cleanup_timeout' ? 'timed_out' : 'failed';
    }
  }

  async attach(active, pendingInteractions) {
    this.bridge.expectReplays(pendingInteractions);
    if (typeof this.client.ensureConnected === 'function') await this.client.ensureConnected();
    this.bind(active);
    const response = await this.client.request(
      'thread/resume',
      protocol.buildThreadResumeParams({
        approvalMode: active.approvalMode,
        threadId: active.nativeThreadId
      })
    );
    const snapshot = await this.restoreSnapshot(active, response);
    if (snapshot.status === 'inProgress' && !active.settled) {
      await this.bridge.waitForExpectedReplays();
    } else {
      this.bridge.cancelExpectedReplays();
      settleSnapshot(active, snapshot);
    }
    const done = active.done.finally(() => this.cleanup(active));
    return {
      nativeTurnId: active.nativeTurnId,
      done,
      abandon: async (reason) => {
        done.catch(() => {});
        return this.abandon(active, reason);
      }
    };
  }

  async restoreSnapshot(active, response) {
    const snapshot = recoveredTurnSnapshot(response, {
      nativeTurnId: active.nativeTurnId,
      clientUserMessageId: active.clientUserMessageId || active.context.runId
    });
    active.nativeTurnId = snapshot.id;
    // Codex thread/resume returns durable history, not missed live notifications.
    // Import that evidence before settling (DSH repair's known-result boundary).
    if (this.importRecoveredHistory) await this.importRecoveredHistory(response, {
      nativeTurnId: snapshot.id, turnId: active.context.turnId
    });
    return snapshot;
  }

  async reconnect(active, response) {
    if (this.getActive() !== active || active.settled) return;
    await this.bridge.writeChain;
    if (this.getActive() !== active || active.settled) return;
    const snapshot = await this.restoreSnapshot(active, response);
    if (this.anchorRecoveredTurn) await this.anchorRecoveredTurn(active, snapshot.id);
    active.submissionUncertain = false;
    if (this.getActive() === active && !active.settled) settleSnapshot(active, snapshot);
  }

  requireContext(context) {
    if (text(context.sessionId) !== this.sessionId) {
      throw new ChatRuntimeError('chat_actor_session_mismatch', 409);
    }
  }
}

function positiveTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CLEANUP_TIMEOUT_MS;
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ChatRuntimeError(
      'codex_recovery_cleanup_timeout', 504
    )), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function recoveredTurnSnapshot(response, anchors = {}) {
  const turns = response && response.thread && Array.isArray(response.thread.turns)
    ? response.thread.turns
    : [];
  const nativeTurnId = text(anchors.nativeTurnId);
  const clientUserMessageId = text(anchors.clientUserMessageId);
  const turn = nativeTurnId
    ? turns.find((entry) => text(entry && entry.id) === nativeTurnId)
    : turnByClientUserMessageId(turns, clientUserMessageId);
  if (!turn) {
    throw new ChatRuntimeError('codex_native_turn_recovery_anchor_missing', 409);
  }
  const id = text(turn && turn.id);
  const status = text(turn && turn.status);
  if (!id || !['inProgress', 'completed', 'interrupted', 'failed'].includes(status)) {
    throw new ChatRuntimeError('codex_native_turn_recovery_missing', 409);
  }
  return { id, status, error: turn.error };
}

function turnByClientUserMessageId(turns, clientUserMessageId) {
  if (!clientUserMessageId) return null;
  const matches = turns.filter((turn) => (
    Array.isArray(turn && turn.items)
    && turn.items.some((item) => (
      item && item.type === 'userMessage'
      && text(item.clientId) === clientUserMessageId
    ))
  ));
  if (matches.length > 1) {
    throw new ChatRuntimeError('codex_native_turn_recovery_anchor_ambiguous', 409);
  }
  return matches[0] || null;
}

function settleSnapshot(active, snapshot) {
  const type = {
    completed: 'turn.completed',
    interrupted: 'turn.interrupted',
    failed: 'turn.failed'
  }[snapshot.status];
  if (type) settleFromNative(active, {
    type,
    payload: { status: snapshot.status, error: snapshot.error }
  });
}

module.exports = { CodexTurnRecovery, recoveredTurnSnapshot };
