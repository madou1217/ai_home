'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');
const { readImageGenerationResponseText } = require('./image-generation-response');
const { isCurrentImageGatewayUrl } = require('./image-generation-url-policy');
const { sanitizeAccessToken } = require('./upstream-endpoints-headers');
const { resolveProviderUpstream, resolveProviderPath } = require('./upstream-endpoints-path');
const { applyAccountUpstreamHeaders } = require('./upstream-account-profile');

function buildUpstreamUrl(base, provider, suffix) {
  const path = resolveProviderPath(provider, `/v1/images/${suffix}`, base);
  return `${base.replace(/\/+$/, '')}${path}`;
}

function readUpstreamErrorBody(status, body) {
  const detail = body && body.error && (body.error.message || body.error.detail) || '';
  return String(detail || `upstream returned HTTP ${status}`).trim();
}

// Shared authenticated, bounded transport. Strategies only encode/decode their
// wire dialect; account selection and retry accounting remain in the executor.
function createImageApiTransport(deps = {}) {
  return async function send(input, request, minimumTimeoutMs = 120000) {
    if (typeof deps.fetchWithTimeout !== 'function') {
      throw new ImageGenerationError(500, 'passthrough_transport_unavailable', 'image API transport is not configured');
    }
    const { account, options = {} } = input;
    const provider = String(account && account.provider || '').trim().toLowerCase();
    const accessToken = sanitizeAccessToken(account && (account.apiKey || account.accessToken));
    if (!accessToken) {
      throw new ImageGenerationError(400, 'invalid_access_token', 'api-key account has no usable key');
    }
    const base = resolveProviderUpstream(options, provider, account);
    if (!base) {
      throw new ImageGenerationError(400, 'account_base_url_missing', 'api-key account has no base url');
    }
    if (isCurrentImageGatewayUrl(base, options.port)) {
      throw new ImageGenerationError(502, 'infinite_loop_detected', 'image API upstream base url is not usable');
    }
    const suffix = input.mode === 'edit' ? 'edits' : 'generations';
    const url = buildUpstreamUrl(base, provider, suffix);
    const timeoutMs = Math.max(Number(options.upstreamTimeoutMs) || 0, minimumTimeoutMs);
    const headers = applyAccountUpstreamHeaders({
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'x-aih-account-ref': String(account && account.accountRef || ''),
      'x-aih-account-email': String(account && account.email || '')
    }, account);
    // The codec owns framing, including multipart's generated boundary.
    delete headers['content-type'];
    Object.assign(headers, request.headers);

    let upstreamRes;
    try {
      upstreamRes = await deps.fetchWithTimeout(url, {
        method: 'POST', headers, body: request.body
      }, timeoutMs, { proxyUrl: options.proxyUrl, noProxy: options.noProxy });
    } catch (error) {
      const wrapped = new ImageGenerationError(
        502, 'upstream_failed', `upstream fetch failed: ${String(error && error.message || error)}`
      );
      wrapped.cause = error;
      wrapped.upstreamUrl = url;
      throw wrapped;
    }
    const text = await readImageGenerationResponseText(upstreamRes, { ...options, upstreamTimeoutMs: timeoutMs });
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch (_error) {}
    if (!upstreamRes.ok) {
      const error = new ImageGenerationError(
        upstreamRes.status, 'upstream_failed', readUpstreamErrorBody(upstreamRes.status, json)
      );
      if (text) error.upstreamBody = text.slice(0, 500);
      error.upstreamUrl = url;
      throw error;
    }
    return json;
  };
}

function readImageApiUsage(json, model) {
  return json.usage && typeof json.usage === 'object'
    ? { usage: json.usage, usageFormat: '', model: String(json.model || model || '').trim() }
    : null;
}

module.exports = { createImageApiTransport, buildUpstreamUrl, readUpstreamErrorBody, readImageApiUsage };
