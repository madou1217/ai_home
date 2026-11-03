'use strict';

// unsubscribe 只确认退订；写锁在 thread/closed 后才真正释放。
class CodexThreadRelease {
  constructor(options) {
    this.request = options.request;
    this.timeoutMs = options.timeoutMs || 12000;
    this.reportFailure = options.reportFailure || (() => {});
    this.pending = new Map();
  }

  release(threadId) {
    const existing = this.pending.get(threadId);
    if (existing) return existing.promise;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const pending = { promise, resolve, acknowledged: false, closed: false };
    this.pending.set(threadId, pending);
    pending.timer = setTimeout(() => this.finish(threadId, pending, {
      released: false, reason: 'codex_thread_release_timeout'
    }), this.timeoutMs);
    Promise.resolve().then(() => this.request('thread/unsubscribe', { threadId })).then(
      (response) => {
        if (this.pending.get(threadId) !== pending) return;
        pending.acknowledged = true;
        const status = response && response.status;
        if (status === 'notLoaded' || status === 'notSubscribed' || (status === 'unsubscribed' && pending.closed)) {
          this.finish(threadId, pending, { released: true, status });
        } else if (status !== 'unsubscribed') {
          this.finish(threadId, pending, { released: false, reason: 'codex_thread_release_invalid_response' });
        }
      },
      (error) => this.finish(threadId, pending, {
        released: false, reason: error && error.code || 'codex_thread_release_failed'
      })
    );
    return promise;
  }

  observe(message) {
    if (message.method !== 'thread/closed') return;
    const threadId = String(message.params && message.params.threadId || '').trim();
    const pending = this.pending.get(threadId);
    if (!pending) return;
    pending.closed = true;
    if (pending.acknowledged) this.finish(threadId, pending, { released: true, status: 'unsubscribed' });
  }

  disconnect() {
    for (const [threadId, pending] of this.pending) {
      this.finish(threadId, pending, { released: false, reason: 'codex_app_server_disconnected' });
    }
  }

  finish(threadId, pending, result) {
    if (this.pending.get(threadId) !== pending) return;
    this.pending.delete(threadId);
    clearTimeout(pending.timer);
    pending.resolve(result);
    if (!result.released) this.reportFailure({ threadId, ...result });
  }
}

module.exports = { CodexThreadRelease };
