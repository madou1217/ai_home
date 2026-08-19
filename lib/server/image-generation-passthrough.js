'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');
const { sanitizeAccessToken } = require('./upstream-endpoints-headers');
const { resolveProviderUpstream, resolveProviderPath } = require('./upstream-endpoints-path');

// Passthrough strategy: any api-key (apiKeyMode) account whose upstream speaks
// the OpenAI wire protocol. The gateway forwards the normalized OpenAI request
// to `{baseUrl}/images/generations` (JSON) or `/images/edits` (multipart, via
// the global FormData — the gateway never parses incoming multipart, it only
// produces it, so no multipart dependency is added), then returns the upstream
// OpenAI response body verbatim. Usage is captured best-effort from the
// upstream `usage` field when present.

function buildUpstreamUrl(base, provider, suffix) {
  const path = resolveProviderPath(provider, `/v1/images/${suffix}`, base);
  return `${base.replace(/\/+$/, '')}${path}`;
}

function readUpstreamErrorBody(status, body) {
  const detail = body && body.error && (body.error.message || body.error.detail) || '';
  return String(detail || `upstream returned HTTP ${status}`).trim();
}

function createPassthroughImageGenerationStrategy(deps = {}) {
  const fetchWithTimeout = deps.fetchWithTimeout;
  return {
    provider: 'passthrough',
    kind: 'passthrough',
    // The upstream endpoint is the authority on which models it can serve.
    supportsModel() {
      return true;
    },
    async generate(input) {
      if (typeof fetchWithTimeout !== 'function') {
        throw new ImageGenerationError(500, 'passthrough_transport_unavailable', 'passthrough transport is not configured');
      }
      const { mode, model, prompt, n, size, quality, responseFormat, image, mask, account, options } = input;
      const provider = String(account && account.provider || '').trim().toLowerCase();
      const accessToken = sanitizeAccessToken(account && (account.apiKey || account.accessToken));
      if (!accessToken) {
        throw new ImageGenerationError(400, 'invalid_access_token', 'api-key account has no usable key');
      }
      const base = resolveProviderUpstream(options || {}, provider, account);
      if (!base) {
        throw new ImageGenerationError(400, 'account_base_url_missing', 'api-key account has no base url');
      }
      const suffix = mode === 'edit' ? 'edits' : 'generations';
      const url = buildUpstreamUrl(base, provider, suffix);
      const timeoutMs = Number(options && options.upstreamTimeoutMs) || 60000;

      const headers = {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
        'x-aih-account-ref': String(account && account.accountRef || ''),
        'x-aih-account-email': String(account && account.email || '')
      };

      const commonFields = { model, prompt, n };
      if (size) commonFields.size = size;
      if (quality) commonFields.quality = quality;
      commonFields.response_format = responseFormat || 'b64_json';

      let body;
      if (mode === 'edit') {
        // Produce (never parse) multipart for the upstream edits endpoint.
        const form = new FormData();
        form.append('image', new Blob([Buffer.from(image.data, 'base64')], { type: image.mimeType }), 'image.png');
        if (mask) {
          form.append('mask', new Blob([Buffer.from(mask.data, 'base64')], { type: mask.mimeType }), 'mask.png');
        }
        Object.entries(commonFields).forEach(([key, value]) => {
          if (value != null) form.append(key, String(value));
        });
        body = form;
        // FormData sets its own multipart content-type with boundary.
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(commonFields);
      }

      let upstreamRes;
      try {
        upstreamRes = await fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body
        }, timeoutMs, {
          proxyUrl: options && options.proxyUrl,
          noProxy: options && options.noProxy
        });
      } catch (error) {
        throw new ImageGenerationError(502, 'upstream_failed', `upstream fetch failed: ${String(error && error.message || error)}`);
      }

      const text = String(await upstreamRes.text().catch(() => '') || '');
      let json = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch (_error) {
        json = {};
      }

      if (!upstreamRes.ok) {
        throw new ImageGenerationError(
          upstreamRes.status,
          'upstream_failed',
          readUpstreamErrorBody(upstreamRes.status, json) || text.slice(0, 200)
        );
      }

      const images = Array.isArray(json.data)
        ? json.data.map((item) => ({
            ...(item && typeof item === 'object' ? item : {}),
            ...(item && item.b64_json ? { b64_json: String(item.b64_json) } : {}),
            ...(item && item.url ? { url: String(item.url) } : {})
          }))
        : [];
      if (images.length === 0) {
        throw new ImageGenerationError(502, 'upstream_failed', 'upstream returned no image data');
      }

      const usageInput = json.usage && typeof json.usage === 'object'
        ? { usage: json.usage, usageFormat: '', model: String(json.model || model || '').trim() }
        : null;

      return { images, usageInput, raw: json };
    }
  };
}

module.exports = {
  createPassthroughImageGenerationStrategy,
  __private: {
    buildUpstreamUrl,
    readUpstreamErrorBody
  }
};
