'use strict';

const { ChatRuntimeError } = require('./contracts');

// Goal state lives outside the native turn history. Resume/reconnect must read
// it separately, using the recovery client while normal requests are suspended.
class CodexSessionGoalSync {
  constructor(options) {
    this.client = options.client;
    this.readSession = options.readSession;
    this.publish = options.publish;
    this.fingerprint = undefined;
    this.revision = 0;
  }

  observe(mapped, persisted) {
    if (!['session.goal.updated', 'session.goal.cleared'].includes(mapped.type)) return;
    const revision = ++this.revision;
    const fingerprint = JSON.stringify(mapped.type === 'session.goal.updated' ? mapped.payload.goal : null);
    Promise.resolve(persisted).then(() => {
      if (revision === this.revision) this.fingerprint = fingerprint;
    }).catch(() => {}); // The event bridge reports persistence failures to the active turn.
  }

  accepts(message) {
    if (!['thread/goal/updated', 'thread/goal/cleared'].includes(message.method)) return true;
    return this.readSession().policy?.contextState?.goalSource !== 'aih';
  }

  async refresh(active, client = this.client) {
    const policy = this.readSession().policy || {};
    // AIH goals are independent of the native goal store, including inherited
    // goals. Re-read ownership each time: a UI command can change it while this
    // driver remains alive. Ordinary goal-free sessions need no extra RPC.
    if (policy.contextState?.goalSource === 'aih'
      || (!policy.lineage && !policy.contextState?.goal)) return;
    let result;
    const revision = this.revision;
    try {
      result = await client.request('thread/goal/get', { threadId: active.nativeThreadId });
    } catch (_error) {
      // Older/temporarily unavailable servers cannot provide a metadata snapshot.
      // Preserve the last observed state; a failed read is never a clear event.
      return;
    }
    // Do not let an in-flight read override a newer AIH command or notification.
    if (revision !== this.revision || this.readSession().policy?.contextState?.goalSource === 'aih') return;
    if (!result || !Object.hasOwn(result, 'goal')) {
      throw new ChatRuntimeError('codex_goal_snapshot_invalid', 502);
    }
    const goal = result.goal;
    if (goal !== null && (!goal || typeof goal !== 'object' || Array.isArray(goal)
      || goal.threadId !== active.nativeThreadId)) {
      throw new ChatRuntimeError('codex_goal_thread_mismatch', 409);
    }
    const fingerprint = JSON.stringify(goal);
    if (fingerprint === this.fingerprint) return;
    await this.publish(goal
      ? { method: 'thread/goal/updated', params: { threadId: active.nativeThreadId, goal } }
      : { method: 'thread/goal/cleared', params: { threadId: active.nativeThreadId } }, active);
    if (revision === this.revision) this.fingerprint = fingerprint;
  }
}

module.exports = { CodexSessionGoalSync };
