'use strict';

const { isDefaultAccountEligible } = require('./account-default-eligibility');

const HIDDEN_MENU_PROVIDERS = new Set(['gemini']);
const PROVIDER_LABELS = Object.freeze({
  agy: 'Antigravity',
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode'
});

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,31}$/.test(provider) ? provider : '';
}

function normalizeAccountRef(value) {
  const accountRef = String(value || '').trim();
  return /^acct_[a-f0-9]{20}$/.test(accountRef) ? accountRef : '';
}

function normalizeText(value, maxLength = 160) {
  return String(value || '').replace(/[\r\n\0]+/g, ' ').trim().slice(0, maxLength);
}

function providerLabel(provider) {
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  return provider
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function formatRemainingPct(value) {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  const clamped = Math.max(0, Math.min(100, numeric));
  const rounded = Math.round(clamped * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function buildUsageLabel(account) {
  if (!account || typeof account !== 'object') return '用量未知';
  if (account.authPending === true) return '等待授权';
  if (account.configured !== true) return '未配置';
  if (account.status === 'down') return '已停用';
  const runtimeStatus = normalizeText(account.runtimeStatus, 48);
  if (runtimeStatus && runtimeStatus !== 'healthy') return '账号异常';
  if (account.apiKeyMode === true) return 'API Key';
  const remainingPct = formatRemainingPct(account.remainingPct);
  if (remainingPct) return `剩余 ${remainingPct}%`;
  return '用量未知';
}

function buildAccountLabel(account, accountRef) {
  const label = normalizeText(account && account.displayName)
    || normalizeText(account && account.email);
  return label || `账号 ${accountRef.slice(-6)}`;
}

function buildMenuAccount(account) {
  const provider = normalizeProvider(account && account.provider);
  const accountRef = normalizeAccountRef(account && account.accountRef);
  if (!provider || !accountRef || HIDDEN_MENU_PROVIDERS.has(provider)) return null;
  return {
    accountRef,
    label: buildAccountLabel(account, accountRef),
    usageLabel: buildUsageLabel(account),
    isDefault: account.isDefault === true,
    switchable: isDefaultAccountEligible(account),
    status: account.status === 'down' ? 'down' : 'up'
  };
}

function buildDesktopMenuSnapshot(accounts, options = {}) {
  const providers = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const provider = normalizeProvider(account && account.provider);
    const menuAccount = buildMenuAccount(account);
    if (!provider || !menuAccount) continue;
    if (!providers.has(provider)) {
      providers.set(provider, {
        id: provider,
        label: providerLabel(provider),
        accounts: []
      });
    }
    providers.get(provider).accounts.push(menuAccount);
  }

  return {
    version: 1,
    generatedAt: Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now(),
    providers: Array.from(providers.values())
  };
}

module.exports = {
  buildDesktopMenuSnapshot,
  __private: {
    buildUsageLabel,
    formatRemainingPct,
    normalizeProvider,
    providerLabel
  }
};
