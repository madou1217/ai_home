'use strict';

// Adapter/resolver layer for Anthropic server-tool compatibility.
//
// Claude Code injects server-side tools (advisor, web_search) directly into the
// `tools` array by API contract. The official Anthropic API accepts the advisor
// variant, but third-party Anthropic-compatible endpoints (GLM/Zhipu, DashScope,
// ...) validate the request body with a strict serde whitelist and reject the
// whole request with a 400 ("unknown variant `advisor_20260301`, expected
// `web_search_...`"). The gateway must therefore strip official-only server tools
// before forwarding to a non-official upstream — and only then, so accounts on
// the real Anthropic endpoint keep the advisor capability.
//
// Keep all advisor/server-tool compatibility knowledge here; do not scatter
// `advisor` string handling across routing or protocol code.

// Server-tool `type` variants only the official Anthropic API understands.
const OFFICIAL_ONLY_SERVER_TOOL_TYPE = /^advisor(?:_|$)/;
// `anthropic-beta` tokens that pair with those official-only server tools.
const OFFICIAL_ONLY_BETA_TOKEN = /^advisor-tool-/;

function isOfficialAnthropicBaseUrl(baseUrl) {
  const text = String(baseUrl || '').trim();
  if (!text) return false;
  try {
    return new URL(text).host.toLowerCase() === 'api.anthropic.com';
  } catch (_error) {
    return false;
  }
}

function isOfficialOnlyServerTool(tool) {
  return Boolean(
    tool
    && typeof tool === 'object'
    && OFFICIAL_ONLY_SERVER_TOOL_TYPE.test(String(tool.type || ''))
  );
}

// Returns { tools, removed }. When `tools` is not an array it is returned
// untouched with an empty `removed` list, so callers can branch on removed.length.
function stripOfficialOnlyServerTools(tools) {
  if (!Array.isArray(tools)) return { tools, removed: [] };
  const removed = [];
  const kept = tools.filter((tool) => {
    if (isOfficialOnlyServerTool(tool)) {
      removed.push(String(tool.type || ''));
      return false;
    }
    return true;
  });
  return { tools: kept, removed };
}

// Returns { value, removed } for an `anthropic-beta` header value, dropping the
// official-only tokens while preserving the rest (and their order).
function sanitizeAnthropicBetaHeader(value) {
  const text = String(value || '').trim();
  if (!text) return { value: text, removed: [] };
  const removed = [];
  const kept = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      if (OFFICIAL_ONLY_BETA_TOKEN.test(part)) {
        removed.push(part);
        return false;
      }
      return true;
    });
  return { value: kept.join(','), removed };
}

module.exports = {
  isOfficialAnthropicBaseUrl,
  isOfficialOnlyServerTool,
  stripOfficialOnlyServerTools,
  sanitizeAnthropicBetaHeader
};
