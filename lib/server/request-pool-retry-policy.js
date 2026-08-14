'use strict';

const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_REQUEST_BUDGET_MS = 30_000;

function normalizeRefSet(values) {
  return new Set(Array.from(values || [], (value) => String(value || '').trim()).filter(Boolean));
}

function decideTransientPoolRetry(input = {}) {
  const provider = String(input.provider || '').trim().toLowerCase();
  if (provider !== 'agy' && provider !== 'gemini') return { retry: false };
  if (!input.codeAssistProvider || input.pinnedAccount || input.retryUsed || input.responseStarted) {
    return { retry: false };
  }

  const attempted = normalizeRefSet(input.attemptedAccountRefs);
  const pending = normalizeRefSet(input.pendingAccountRefs);
  if (input.immediateFailureRecorded || attempted.size < 2 || pending.size !== attempted.size) {
    return { retry: false };
  }
  for (const accountRef of attempted) {
    if (!pending.has(accountRef)) return { retry: false };
  }

  const delayMs = Math.max(0, Number(input.delayMs) || DEFAULT_RETRY_DELAY_MS);
  const elapsedMs = Math.max(0, Number(input.elapsedMs) || 0);
  const requestBudgetMs = Math.max(1000, Number(input.requestBudgetMs) || DEFAULT_REQUEST_BUDGET_MS);
  if (elapsedMs + delayMs + 1000 >= requestBudgetMs) return { retry: false };

  return {
    retry: true,
    delayMs,
    allowModelCooled: true
  };
}

module.exports = {
  DEFAULT_REQUEST_BUDGET_MS,
  DEFAULT_RETRY_DELAY_MS,
  decideTransientPoolRetry
};
