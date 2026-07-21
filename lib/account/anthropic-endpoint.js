'use strict';

// Shared, dependency-free helpers for classifying a Claude/Anthropic base URL.
//
// The advisor server tool (tool variant `advisor_20260301` + its `advisor-tool-*`
// beta) is a first-party-only capability: only the official `api.anthropic.com`
// endpoint can execute it. Claude Code already suppresses first-party-only betas
// for Bedrock/Vertex, but treats a custom `ANTHROPIC_BASE_URL` (DeepSeek, GLM/
// Zhipu, DashScope, ...) as first-party and injects advisor anyway — which strict
// third-party endpoints (e.g. DeepSeek's serde) reject with a 400.
//
// `shouldDisableAdvisorForBaseUrl` is the single policy source: disable advisor
// only for an account that talks DIRECTLY to a non-official endpoint. A loopback
// URL is the local aih gateway (self-relay) — its real upstream is decided there,
// so advisor is left alone for those.

function parseHost(baseUrl) {
  const text = String(baseUrl || '').trim();
  if (!text) return '';
  try {
    return new URL(text).hostname.toLowerCase();
  } catch (_error) {
    return '';
  }
}

function isOfficialAnthropicBaseUrl(baseUrl) {
  return parseHost(baseUrl) === 'api.anthropic.com';
}

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost'
    || h === '::1'
    || h === '0.0.0.0'
    || /^127\./.test(h);
}

// True only for an explicit, non-official, non-loopback (direct third-party)
// endpoint. Empty/unparseable/official/self-relay → false (keep advisor on).
function shouldDisableAdvisorForBaseUrl(baseUrl) {
  const host = parseHost(baseUrl);
  if (!host) return false;
  if (host === 'api.anthropic.com') return false;
  if (isLoopbackHost(host)) return false;
  return true;
}

module.exports = {
  isOfficialAnthropicBaseUrl,
  shouldDisableAdvisorForBaseUrl
};
