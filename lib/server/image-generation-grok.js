'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');
const { isImageGenerationModel } = require('./code-assist-image-generation');
const { sanitizeAccessToken } = require('./upstream-endpoints-headers');

// Native strategy for grok OAuth accounts. The grok client token (auth.x.ai
// OIDC) is accepted by the official xAI API, so this strategy forwards the
// OpenAI-compatible request to `{baseUrl}/images/generations` (default
// https://api.x.ai/v1) with the Bearer oauth token.
//
// The upstream model field only accepts grok-imagine-* names — the requested
// model name is an intent marker resolved through the candidate list below.
// Wire parameters n and quality are forwarded (the upstream supports them);
// size/aspect_ratio are not mapped from OpenAI's size field because the
// translation is lossy. Edit mode embeds the source image as a data URL in the
// same endpoint (xAI image-to-image), no multipart needed.

const GROK_IMAGE_UPSTREAM_MODEL_CANDIDATES = ['grok-imagine-image-2.0', 'grok-imagine-image'];

function resolveGrokImageUpstreamModel(model, options) {
  const explicit = String(options && options.grokImageUpstreamModel || '').trim();
  if (explicit) return explicit;
  return GROK_IMAGE_UPSTREAM_MODEL_CANDIDATES[0];
}

function buildGrokImageUrl(base) {
  return `${String(base || '').replace(/\/+$/, '')}/images/generations`;
}

function readGrokErrorBody(status, json) {
  const error = json && json.error;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    return String(error.message || error.detail || `upstream returned HTTP ${status}`).trim();
  }
  return `upstream returned HTTP ${status}`;
}

function createGrokImageGenerationStrategy(deps = {}) {
  const fetchWithTimeout = deps.fetchWithTimeout;
  const refreshGrokAccessToken = deps.refreshGrokAccessToken;
  return {
    provider: 'grok',
    kind: 'native',
    supportsModel(modelId) {
      return isImageGenerationModel(modelId);
    },
    async generate(input) {
      if (typeof fetchWithTimeout !== 'function') {
        throw new ImageGenerationError(500, 'grok_transport_unavailable', 'grok transport is not configured');
      }
      const { mode, model, prompt, n, quality, responseFormat, image, account, options } = input;
      const timeoutMs = Math.max(Number(options && options.upstreamTimeoutMs) || 0, 120000);

      if (typeof refreshGrokAccessToken === 'function') {
        try {
          await refreshGrokAccessToken(account, {
            force: false,
            timeoutMs,
            proxyUrl: options && options.proxyUrl,
            noProxy: options && options.noProxy
          }, { fetchWithTimeout });
        } catch (_error) {}
      }

      const accessToken = sanitizeAccessToken(account && account.accessToken);
      if (!accessToken) {
        throw new ImageGenerationError(400, 'invalid_access_token', 'grok account has no usable access token');
      }

      const base = String(account && account.openaiBaseUrl || '').trim() || 'https://api.x.ai/v1';
      const url = buildGrokImageUrl(base);

      const payload = {
        model: resolveGrokImageUpstreamModel(model, options),
        prompt,
        ...(mode === 'edit' && image ? { image: `data:${image.mimeType};base64,${image.data}` } : {}),
        ...(Number(n) > 1 ? { n: Number(n) } : {}),
        ...(quality ? { quality } : {}),
        response_format: responseFormat === 'url' ? 'url' : 'b64_json'
      };

      const headers = {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-aih-account-ref': String(account && account.accountRef || ''),
        'x-aih-account-email': String(account && account.email || '')
      };

      let upstreamRes;
      try {
        upstreamRes = await fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload)
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
        const err = new ImageGenerationError(
          upstreamRes.status,
          'upstream_failed',
          readGrokErrorBody(upstreamRes.status, json) || text.slice(0, 200)
        );
        if (text) err.upstreamBody = text.slice(0, 500);
        throw err;
      }

      const images = Array.isArray(json.data)
        ? json.data.map((item) => ({
            ...(item && typeof item === 'object' ? item : {}),
            ...(item && item.b64_json ? { b64_json: String(item.b64_json) } : {}),
            ...(item && item.url ? { url: String(item.url) } : {})
          }))
        : [];
      if (images.length === 0) {
        throw new ImageGenerationError(502, 'upstream_failed', 'grok returned no image data');
      }

      const usageInput = json.usage && typeof json.usage === 'object'
        ? { usage: json.usage, usageFormat: '', model: String(json.model || model || '').trim() }
        : null;

      return { images, usageInput, raw: json };
    }
  };
}

module.exports = {
  createGrokImageGenerationStrategy,
  __private: {
    buildGrokImageUrl,
    readGrokErrorBody,
    resolveGrokImageUpstreamModel
  }
};