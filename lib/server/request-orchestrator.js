'use strict';

async function runWithAccountAttempts(options = {}) {
  const pool = Array.isArray(options.pool) ? options.pool : [];
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 1);
  const chooseServerAccount = options.chooseServerAccount;
  const provider = String(options.provider || '').trim().toLowerCase();
  const sessionKey = String(options.sessionKey || '').trim();
  const cursorState = options.cursorState || {};
  const selectionState = options.selectionState || cursorState;
  const cursorKey = String(options.cursorKey || provider || 'cursor');
  const model = String(options.model || '').trim();
  const attemptedAccountRefs = new Set();
  let lastError = '';

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const account = typeof chooseServerAccount === 'function'
      ? chooseServerAccount(pool, selectionState, cursorKey, {
          provider,
          sessionKey,
          model,
          excludeAccountRefs: attemptedAccountRefs,
          cursorState,
          strategy: options.strategy,
          allowModelCooled: Boolean(options.allowModelCooled)
        })
      : null;
    if (!account) {
      return {
        kind: 'no_account',
        attemptedAccountRefs,
        lastError
      };
    }
    const accountRef = String(account.accountRef || '');
    attemptedAccountRefs.add(accountRef);

    const outcome = await options.onAttempt(account, {
      attempt,
      attemptedAccountRefs,
      setLastError(detail) {
        lastError = String(detail || '');
      },
      retrySameAccount() {
        attemptedAccountRefs.delete(accountRef);
      }
    });

    if (outcome && outcome.action === 'return') {
      return {
        kind: 'returned',
        attemptedAccountRefs,
        lastError,
        value: outcome.value
      };
    }
    if (outcome && outcome.action === 'retry_same') {
      attemptedAccountRefs.delete(accountRef);
      continue;
    }
    if (outcome && outcome.action === 'retry_next') {
      continue;
    }
    if (outcome && outcome.action === 'break') {
      return {
        kind: 'broken',
        attemptedAccountRefs,
        lastError
      };
    }
  }

  return {
    kind: 'attempts_exhausted',
    attemptedAccountRefs,
    lastError
  };
}

module.exports = {
  runWithAccountAttempts
};
