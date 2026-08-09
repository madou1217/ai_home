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
  let deferredSameAccount = null;
  let deferredSameAccountUsed = false;
  // 软冷却逃生阀。语义上「软」就是可以被越过的：(账号,模型) 冷却记录的是上一次
  // 请求的遭遇，不是这次的判决。此前只有别名路径会打开它，具体模型请求在全池软
  // 冷却时直接 503 no_available_account——而冷却可能只是一次本地代理抖动
  // （ECONNREFUSED），账号完全健康。宁可真打一次上游拿到真实答复，也不要合成一个
  // 「没有可调度账号」的谎报。硬阻断（auth_invalid / 账号级 cooldownUntil /
  // schedulableStatus / 配额耗尽）不在此列，仍由选择器拦下。
  let allowModelCooled = Boolean(options.allowModelCooled);

  const selectAccount = () => (typeof chooseServerAccount === 'function'
    ? chooseServerAccount(pool, selectionState, cursorKey, {
        provider,
        sessionKey,
        model,
        excludeAccountRefs: attemptedAccountRefs,
        cursorState,
        strategy: options.strategy,
        allowModelCooled
      })
    : null);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let account = selectAccount();
    if (!account && !allowModelCooled) {
      // 粘住而不是只放行一次：两个账号都在软冷却时，一次性放行只会试到第一个，
      // 它再失败就又回到「无账号」。置位后剩余尝试继续放行，轮转会走完所有被
      // 冷却的账号，最终把真实的上游失败带回给客户端。
      allowModelCooled = true;
      account = selectAccount();
    }
    if (!account && deferredSameAccount && !deferredSameAccountUsed) {
      account = deferredSameAccount;
      deferredSameAccount = null;
      deferredSameAccountUsed = true;
    }
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
      },
      deferSameAccountRetry() {
        if (deferredSameAccountUsed || deferredSameAccount) return false;
        deferredSameAccount = account;
        return true;
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
    if (outcome && outcome.action === 'retry_transient') {
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
