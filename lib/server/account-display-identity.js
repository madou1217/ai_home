'use strict';

const INTERNAL_ACCOUNT_LABEL_RE = /^(agy|codex|gemini|claude|opencode)-\d+$/i;

const DEFAULT_API_KEY_DOMAINS = Object.freeze({
  codex: 'api.openai.com',
  claude: 'api.anthropic.com',
  agy: 'daily-cloudcode-pa.googleapis.com',
  gemini: 'generativelanguage.googleapis.com',
  opencode: 'opencode.ai'
});

function isInternalAccountDisplayName(value) {
  return INTERNAL_ACCOUNT_LABEL_RE.test(String(value || '').trim());
}

function cleanOauthDisplayName(value) {
  const text = String(value || '').trim();
  if (!text || text === 'Unknown') return '';
  if (isInternalAccountDisplayName(text)) return '';
  if (/^api key/i.test(text)) return '';
  if (/^access token/i.test(text)) return '';
  return text;
}

function pickOauthDisplayName(...values) {
  for (const value of values) {
    const cleaned = cleanOauthDisplayName(value);
    if (cleaned) return cleaned;
  }
  return '';
}

function getBaseDomain(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return parsed.host.replace(/^www\./i, '');
  } catch (_error) {
    return raw
      .replace(/^[a-z]+:\/\//i, '')
      .split(/[/?#]/, 1)[0]
      .replace(/^www\./i, '');
  }
}

function getApiKeyDisplayName(provider, config = {}) {
  const domain = getBaseDomain(config.baseUrl || config.openaiBaseUrl || config.anthropicBaseUrl);
  if (domain) return domain;
  return DEFAULT_API_KEY_DOMAINS[String(provider || '').trim().toLowerCase()] || 'API Key';
}

module.exports = {
  cleanOauthDisplayName,
  getApiKeyDisplayName,
  getBaseDomain,
  isInternalAccountDisplayName,
  pickOauthDisplayName
};
