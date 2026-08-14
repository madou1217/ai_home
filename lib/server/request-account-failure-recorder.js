'use strict';

function createRequestAccountFailureRecorder(applyFailure) {
  const pending = new Map();
  let immediateFailureRecorded = false;

  function apply(account, policy) {
    if (typeof applyFailure === 'function') applyFailure(account, policy);
  }

  function commit() {
    const entries = Array.from(pending.values());
    pending.clear();
    entries.forEach(({ account, policy }) => apply(account, policy));
    return entries.length;
  }

  return {
    record(account, policy) {
      if (!policy || policy.deferAccountFailureUntilRequestOutcome !== true) {
        immediateFailureRecorded = true;
        apply(account, policy);
        return;
      }
      const accountRef = String(account && account.accountRef || '').trim();
      pending.set(accountRef || `anonymous-${pending.size}`, { account, policy });
    },

    recordSuccess(account) {
      const accountRef = String(account && account.accountRef || '').trim();
      if (accountRef) pending.delete(accountRef);
    },

    snapshot() {
      return {
        pendingAccountRefs: Array.from(pending.keys()),
        immediateFailureRecorded
      };
    },

    finalize(options = {}) {
      if (options.requestSucceeded === true || pending.size < 2) {
        return { committed: commit(), discarded: 0 };
      }
      const discardedAccountRefs = Array.from(pending.keys());
      pending.clear();
      return {
        committed: 0,
        discarded: discardedAccountRefs.length,
        discardedAccountRefs
      };
    }
  };
}

module.exports = {
  createRequestAccountFailureRecorder
};
