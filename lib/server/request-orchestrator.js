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
  const allAttemptedAccountRefs = new Set();
  let lastError = '';
  let deferredSameAccount = null;
  let deferredSameAccountUsed = false;
  let retryRoundStarted = false;
  let attempt = 0;
  let attemptLimit = maxAttempts;
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
        allowModelCooled,
        preferredAccountRefs: options.preferredAccountRefs
      })
    : null);

  const tryStartRetryRound = async (reason, attempt) => {
    if (retryRoundStarted || typeof options.prepareRetryRound !== 'function') return false;
    const decision = await options.prepareRetryRound({
      reason,
      attempt,
      attemptedAccountRefs: new Set(attemptedAccountRefs),
      allAttemptedAccountRefs: new Set(allAttemptedAccountRefs),
      lastError
    });
    if (!decision || decision.retry !== true) return false;
    retryRoundStarted = true;
    attemptedAccountRefs.clear();
    deferredSameAccount = null;
    deferredSameAccountUsed = false;
    if (decision.allowModelCooled === true) allowModelCooled = true;
    return true;
  };

  while (true) {
    while (attempt < attemptLimit) {
      let account = selectAccount();
      if (!account && !allowModelCooled) {
        // 粘住而不是只放行一次：两个账号都在软冷却时，一次性放行只会试到第一个，
        // 第一个失败后又会退回 no_account。置位后剩余尝试继续走完整个软冷却池。
        allowModelCooled = true;
        account = selectAccount();
      }
      if (!account && deferredSameAccount && !deferredSameAccountUsed) {
        account = deferredSameAccount;
        deferredSameAccount = null;
        deferredSameAccountUsed = true;
      }
      if (!account) {
        if (await tryStartRetryRound('no_account', attempt)) {
          attemptLimit += Math.max(1, Number(options.retryRoundMaxAttempts) || pool.length);
          continue;
        }
        return { kind: 'no_account', attemptedAccountRefs: allAttemptedAccountRefs, lastError };
      }
      const accountRef = String(account.accountRef || '');
      attemptedAccountRefs.add(accountRef);
      allAttemptedAccountRefs.add(accountRef);
      const currentAttempt = attempt;
      attempt += 1;
      // 账号活动计数：attempt 进入即视为该账号在服务（in-flight +1、速率采样），
      // 结束（含异常/重试分支）在 finally 统一 -1，天然配对不泄漏。
      const accountActivity = options.accountActivity;
      if (accountActivity && typeof accountActivity.begin === 'function') {
        accountActivity.begin(provider, accountRef, model);
      }
      let outcome;
      let attemptError = null;
      const attemptStartedAt = Date.now();
      try {
        const attemptControl = {
          attempt: currentAttempt,
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
        };
        // 插件中间件（可选）包在尝试外面：只能拒绝这次尝试或在未提交的失败上停止换号，不能增加尝试。
        outcome = typeof options.wrapAttempt === 'function'
          ? await options.wrapAttempt(account, { attempt: currentAttempt, lastError: () => lastError }, () => options.onAttempt(account, attemptControl))
          : await options.onAttempt(account, attemptControl);
      } catch (error) {
        attemptError = error;
        throw error;
      } finally {
        if (accountActivity && typeof accountActivity.end === 'function') {
          accountActivity.end(provider, accountRef, model);
        }
        // 插件观察（可选）：只交出低敏摘要，回调本身不得抛出、不阻塞（由调用方保证异步投递）。
        if (typeof options.observeAttempt === 'function') {
          try {
            options.observeAttempt({
              attempt: currentAttempt,
              accountRef,
              outcome: attemptError ? 'error' : String(outcome && outcome.action || 'unknown'),
              error: String(attemptError ? (attemptError.code || attemptError.message) : lastError || '').slice(0, 300),
              durationMs: Date.now() - attemptStartedAt
            });
          } catch (_error) {}
        }
      }
      if (outcome && outcome.action === 'return') {
        return { kind: 'returned', attemptedAccountRefs: allAttemptedAccountRefs, lastError, value: outcome.value };
      }
      // 插件要求停止换号：按尝试耗尽结束，调用方照常用 lastError 写出失败响应。
      if (outcome && outcome.pluginStop === true && outcome.action !== 'break') {
        return { kind: 'attempts_exhausted', attemptedAccountRefs: allAttemptedAccountRefs, lastError, stoppedByPlugin: true };
      }
      if (outcome && outcome.action === 'retry_same') attemptedAccountRefs.delete(accountRef);
      if (outcome && outcome.action === 'break') {
        return { kind: 'broken', attemptedAccountRefs: allAttemptedAccountRefs, lastError };
      }
    }
    if (!await tryStartRetryRound('attempts_exhausted', attempt)) break;
    attemptLimit += Math.max(1, Number(options.retryRoundMaxAttempts) || pool.length);
  }

  return {
    kind: 'attempts_exhausted',
    attemptedAccountRefs: allAttemptedAccountRefs,
    lastError
  };
}

module.exports = {
  runWithAccountAttempts
};
