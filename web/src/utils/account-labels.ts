import type { Account, Provider } from '@/types';

const INTERNAL_ACCOUNT_LABEL_RE = /^(codex|gemini|claude)-\d+$/i;
const DEFAULT_API_KEY_DOMAINS: Record<Provider, string> = {
  codex: 'api.openai.com',
  claude: 'api.anthropic.com',
  gemini: 'generativelanguage.googleapis.com'
};

export function isInternalAccountLabel(value?: string) {
  return INTERNAL_ACCOUNT_LABEL_RE.test(String(value || '').trim());
}

export function getBaseDomain(value?: string) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return parsed.hostname.replace(/^www\./i, '');
  } catch (_error) {
    return raw
      .replace(/^[a-z]+:\/\//i, '')
      .split(/[/?#]/, 1)[0]
      .replace(/:\d+$/, '')
      .replace(/^www\./i, '');
  }
}

function getCleanDisplayName(account: Pick<Account, 'displayName'>) {
  const displayName = String(account.displayName || '').trim();
  if (!displayName || displayName === 'Unknown') return '';
  if (isInternalAccountLabel(displayName)) return '';
  if (/^api key/i.test(displayName)) return '';
  return displayName;
}

export function getAccountIdentityLabel(account: Pick<Account, 'provider' | 'email' | 'displayName' | 'configured' | 'apiKeyMode' | 'baseUrl'>) {
  if (account.apiKeyMode) {
    return getBaseDomain(account.baseUrl) || DEFAULT_API_KEY_DOMAINS[account.provider] || 'API Key';
  }

  const email = String(account.email || '').trim();
  if (email) return email;

  const displayName = getCleanDisplayName(account);
  if (displayName) return displayName;

  return account.configured ? '账号待识别' : 'OAuth 授权中';
}

export function getAccountSecondaryIdentity(account: Pick<Account, 'email' | 'displayName' | 'apiKeyMode'>) {
  if (account.apiKeyMode) return '';
  const email = String(account.email || '').trim();
  const displayName = getCleanDisplayName(account);
  if (!displayName || displayName === email) return '';
  return displayName;
}
