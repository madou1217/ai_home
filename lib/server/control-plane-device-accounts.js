'use strict';

const { isAccountRef } = require('./account-ref-store');

function normalizeText(value, maxLength = 160) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeCount(value) {
  return Math.max(0, Math.floor(normalizeNumber(value, 0)));
}

function normalizePercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, number));
}

function normalizeProvider(value) {
  return normalizeText(value, 64).toLowerCase();
}

function normalizeAccountStatus(value) {
  return normalizeText(value, 32).toLowerCase() === 'down' ? 'down' : 'up';
}

function buildAccountLabel(account, provider) {
  const email = normalizeText(account.email, 160);
  if (email) return email;
  const planType = normalizeText(account.planType, 64);
  return planType ? `${provider} ${planType}` : `${provider} account`;
}

function buildAccountRef(account) {
  const accountRef = normalizeText(account && account.accountRef, 64);
  return isAccountRef(accountRef) ? accountRef : '';
}

function serializeDeviceAccount(account) {
  const source = account && typeof account === 'object' ? account : {};
  const provider = normalizeProvider(source.provider || 'codex');
  const accountRef = buildAccountRef(source);
  if (!provider || !accountRef) return null;
  return {
    accountRef,
    provider,
    label: buildAccountLabel(source, provider),
    status: normalizeAccountStatus(source.status),
    authMode: source.apiKeyMode ? 'api-key' : 'oauth',
    planType: normalizeText(source.planType, 64),
    runtimeStatus: normalizeText(source.runtimeStatus || 'healthy', 64),
    quotaStatus: normalizeText(source.quotaStatus, 64),
    schedulableStatus: normalizeText(source.schedulableStatus, 64),
    remainingPct: normalizePercent(source.remainingPct),
    modelCooldownCount: normalizeCount(source.modelCooldownCount),
    lastRefresh: normalizeCount(source.lastRefresh),
    successCount: normalizeCount(source.successCount),
    failCount: normalizeCount(source.failCount)
  };
}

function summarizeDeviceAccounts(accounts) {
  const summary = {
    total: accounts.length,
    active: 0,
    byProvider: {},
    byRuntimeStatus: {},
    bySchedulableStatus: {}
  };
  accounts.forEach((account) => {
    if (account.runtimeStatus === 'healthy') summary.active += 1;
    summary.byProvider[account.provider] = normalizeCount(summary.byProvider[account.provider]) + 1;
    summary.byRuntimeStatus[account.runtimeStatus] = normalizeCount(summary.byRuntimeStatus[account.runtimeStatus]) + 1;
    const schedulable = account.schedulableStatus || 'unknown';
    summary.bySchedulableStatus[schedulable] = normalizeCount(summary.bySchedulableStatus[schedulable]) + 1;
  });
  return summary;
}

function buildControlPlaneDeviceAccounts(managementAccounts) {
  const source = managementAccounts && typeof managementAccounts === 'object' ? managementAccounts : {};
  const accounts = (Array.isArray(source.accounts) ? source.accounts : [])
    .map(serializeDeviceAccount)
    .filter(Boolean)
    .sort((left, right) => left.provider.localeCompare(right.provider)
      || left.label.localeCompare(right.label)
      || left.accountRef.localeCompare(right.accountRef));
  return {
    accounts,
    summary: summarizeDeviceAccounts(accounts)
  };
}

module.exports = {
  buildControlPlaneDeviceAccounts,
  serializeDeviceAccount
};
