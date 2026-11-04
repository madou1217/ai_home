'use strict';

// 单个账号的"贵"展示态：读凭据、刷新索引态、用量标签、套餐徽章。
//
// 只在这里实现一次，主线程的兜底补算和 worker 里的补算都调它——两条路必须给出
// 完全一样的字段，否则 ls 会出现"用了 worker 就少一块东西"的隐性差异。

/**
 * @returns {null | {
 *   status: object|null,
 *   apiKeyMode: boolean,
 *   baseUrl: string,
 *   derived: object|null,
 *   usageLabel: string,
 *   planBadge: string
 * }}
 */
function enrichAccountView(input = {}) {
  const {
    provider,
    accountRef,
    indexRow,
    fs,
    aiHomeDir,
    readAccountCredentials,
    checkStatus,
    formatUsageLabel,
    formatAccountPlanBadge,
    refreshIndexedStateForAccount
  } = input;
  if (!provider || !accountRef) return null;

  let status = null;
  if (typeof checkStatus === 'function') {
    try {
      status = checkStatus(provider, accountRef);
    } catch (_error) {
      status = null;
    }
  }

  let credentials = {};
  if (typeof readAccountCredentials === 'function') {
    try {
      credentials = readAccountCredentials(fs, aiHomeDir, accountRef) || {};
    } catch (_error) {
      credentials = {};
    }
  }
  const apiKeyMode = Boolean(
    (indexRow && indexRow.apiKeyMode)
    || credentials.OPENAI_API_KEY
    || credentials.ANTHROPIC_API_KEY
    || credentials.ANTHROPIC_AUTH_TOKEN
    || credentials.GEMINI_API_KEY
    || credentials.GOOGLE_API_KEY
  );
  const baseUrl = String(
    credentials.OPENAI_BASE_URL
    || credentials.ANTHROPIC_BASE_URL
    || credentials.GEMINI_BASE_URL
    || ''
  ).trim();

  let derived = null;
  if (typeof refreshIndexedStateForAccount === 'function') {
    try {
      derived = refreshIndexedStateForAccount(provider, accountRef, { refreshSnapshot: false });
    } catch (_error) {
      derived = null;
    }
  }

  const accountName = status && status.accountName ? String(status.accountName) : '';
  let usageLabel = '';
  if (!apiKeyMode && typeof formatUsageLabel === 'function') {
    try {
      usageLabel = String(formatUsageLabel(provider, accountRef, accountName) || '');
    } catch (_error) {
      usageLabel = '';
    }
  }

  let planBadge = '';
  if (typeof formatAccountPlanBadge === 'function') {
    try {
      planBadge = String(formatAccountPlanBadge(provider, accountRef, { apiKeyMode }) || '');
    } catch (_error) {
      planBadge = '';
    }
  }

  return {
    status: status && typeof status === 'object' ? status : null,
    apiKeyMode,
    baseUrl,
    derived: derived && typeof derived === 'object' ? derived : null,
    usageLabel,
    planBadge
  };
}

module.exports = {
  enrichAccountView
};
