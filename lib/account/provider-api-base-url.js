'use strict';

// Upstream base URL for the API-key/OAuth style providers whose endpoint is a
// plain HTTPS host (grok / kimi / kiro), kept in ONE place.
//
// The four core providers (codex / claude / gemini / agy) deliberately resolve
// their base URL differently on each path — Code Assist needs a default that the
// chat path must not apply, and claude honours an account-level override — so
// they stay with their callers. This module owns only the providers whose rule
// is identical everywhere, which is exactly the set that used to be missing:
// `resolveProviderUpstream` (chat) knew about them while
// `resolveProviderBaseUrl` (model probe / usage) silently fell through to
// `codexBaseUrl`, i.e. probed a kimi account against chatgpt.com.
//
// Returning '' means "not owned here" — the caller must NOT substitute another
// provider's endpoint for it. A wrong-but-plausible base URL is worse than an
// empty one: it fails as an auth error against someone else's host instead of a
// clear misconfiguration.

const { resolveKimiBaseUrl } = require('./kimi-endpoints');

const GROK_DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const KIRO_DEFAULT_BASE_URL = 'https://q.us-east-1.amazonaws.com';

function stripTrailingSlashes(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function readAccountOpenAiBaseUrl(account) {
  return String(account && account.openaiBaseUrl || '').trim();
}

// '' when the provider is not one of grok/kimi/kiro.
function resolveProviderApiBaseUrl(provider, account) {
  const normalized = String(provider || '').trim().toLowerCase();
  const fromAccount = readAccountOpenAiBaseUrl(account);

  if (normalized === 'grok') {
    return stripTrailingSlashes(fromAccount || GROK_DEFAULT_BASE_URL);
  }
  if (normalized === 'kimi') {
    // kimi splits by credential kind: the coding endpoint for OAuth logins,
    // the public API host for raw API keys.
    return stripTrailingSlashes(resolveKimiBaseUrl({
      baseUrl: fromAccount,
      apiKeyMode: Boolean(account && account.apiKeyMode)
    }));
  }
  if (normalized === 'kiro') {
    return stripTrailingSlashes(fromAccount || KIRO_DEFAULT_BASE_URL);
  }
  return '';
}

function ownsProviderApiBaseUrl(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  return normalized === 'grok' || normalized === 'kimi' || normalized === 'kiro';
}

module.exports = {
  GROK_DEFAULT_BASE_URL,
  KIRO_DEFAULT_BASE_URL,
  resolveProviderApiBaseUrl,
  ownsProviderApiBaseUrl
};
