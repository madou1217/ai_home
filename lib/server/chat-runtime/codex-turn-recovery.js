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
      return await this.attach(active, context.pendingInteractions || []);
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
    const snapshot = recoveredTurnSnapshot(response, {
      nativeTurnId: active.nativeTurnId,
      clientUserMessageId: active.clientUserMessageId
    });
    active.nativeTurnId = snapshot.id;
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
