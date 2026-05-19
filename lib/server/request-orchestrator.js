'use strict';

async function runWithAccountAttempts(options = {}) {
  const pool = Array.isArray(options.pool) ? options.pool : [];
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || 1);
  const chooseServerAccount = options.chooseServerAccount;
  const provider = String(options.provider || '').trim().toLowerCase();
  const sessionKey = String(options.sessionKey || '').trim();
  const cursorState = options.cursorState || {};
  const cursorKey = String(options.cursorKey || provider || 'cursor');
  const attemptedIds = new Set();
  let lastError = '';

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const account = typeof chooseServerAccount === 'function'
      ? chooseServerAccount(pool, cursorState, cursorKey, {
          provider,
          sessionKey,
          excludeIds: attemptedIds
        })
      : null;
    if (!account) {
      return {
        kind: 'no_account',
        attemptedIds,
        lastError
      };
    }
    const accountId = String(account.id || '');
    attemptedIds.add(accountId);

    const outcome = await options.onAttempt(account, {
      attempt,
      attemptedIds,
      setLastError(detail) {
        lastError = String(detail || '');
      },
      retrySameAccount() {
        attemptedIds.delete(accountId);
      }
    });

    if (outcome && outcome.action === 'return') {
      return {
        kind: 'returned',
        attemptedIds,
        lastError,
        value: outcome.value
      };
    }
    if (outcome && outcome.action === 'retry_same') {
      attemptedIds.delete(accountId);
      continue;
    }
    if (outcome && outcome.action === 'retry_next') {
      continue;
    }
    if (outcome && outcome.action === 'break') {
      return {
        kind: 'broken',
        attemptedIds,
        lastError
      };
    }
  }

  return {
    kind: 'attempts_exhausted',
    attemptedIds,
    lastError
  };
}

module.exports = {
  runWithAccountAttempts
};
