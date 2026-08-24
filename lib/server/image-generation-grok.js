'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');
const {
  getNativeImageCapabilities,
  getNativeImageQualityOptions,
  imageModelBelongsToProvider
} = require('./image-generation-model-specs');
const { readImageGenerationResponseText } = require('./image-generation-response');
const { isCurrentImageGatewayUrl } = require('./image-generation-url-policy');
const { sanitizeAccessToken } = require('./upstream-endpoints-headers');

// Native strategy for grok OAuth accounts. The grok client token (auth.x.ai
// OIDC) is accepted by the official xAI API, so this strategy forwards the
// OpenAI-compatible request to `{baseUrl}/images/generations` (default
// https://api.x.ai/v1) with the Bearer oauth token.
//
// The upstream model field only accepts grok-imagine-* names. Generic AIH
// aliases are resolved to the preferred candidate, while an explicit upstream
// grok-imagine model is preserved. `grok-imagine-image-2.0` accepts low/medium
// quality; legacy variants do not accept the quality field. size/aspect_ratio
// are not mapped from OpenAI's size field because that translation is lossy.

const GROK_IMAGE_UPSTREAM_MODEL_CANDIDATES = ['grok-imagine-image-2.0', 'grok-imagine-image'];

function resolveGrokImageUpstreamModel(model, options) {
  const explicit = String(options && options.grokImageUpstreamModel || '').trim();
  if (explicit) return explicit;
  const requested = String(model || '').trim();
  if (/^grok-imagine-image(?:$|[-._])/i.test(requested)) return requested;
  return GROK_IMAGE_UPSTREAM_MODEL_CANDIDATES[0];
}

function resolveGrokQuality(model, quality) {
  const value = String(quality || '').trim().toLowerCase();
  if (!value || value === 'auto') return '';
  const capabilities = getNativeImageCapabilities('grok', model) || {};
  if (capabilities.quality !== true) {
    throw new ImageGenerationError(400, 'unsupported_image_quality', `grok does not support image quality controls for model ${model}`);
  }
  const supported = getNativeImageQualityOptions('grok', model);
  if (supported.length > 0 && !supported.includes(value)) {
    throw new ImageGenerationError(400, 'unsupported_image_quality_value', `grok does not support image quality ${value} for model ${model}`);
  }
  return value;
}

function buildGrokImageUrl(base, mode = 'generation') {
  const operation = mode === 'edit' ? 'edits' : 'generations';
  return `${String(base || '').replace(/\/+$/, '')}/images/${operation}`;
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
    capabilities: getNativeImageCapabilities('grok'),
    capabilitiesForModel(modelId) {
      return getNativeImageCapabilities('grok', modelId);
    },
    qualityOptionsForModel(modelId) {
      return getNativeImageQualityOptions('grok', modelId);
    },
    supportsModel(modelId) {
      return imageModelBelongsToProvider('grok', modelId);
    },
    async generate(input) {
      if (typeof fetchWithTimeout !== 'function') {
        throw new ImageGenerationError(500, 'grok_transport_unavailable', 'grok transport is not configured');
      }
      const { mode, model, prompt, n, quality, responseFormat, images: inputImages, account, options } = input;
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
      if (isCurrentImageGatewayUrl(base, options && options.port)) {
        throw new ImageGenerationError(502, 'infinite_loop_detected', 'grok upstream base url is not usable');
      }
      const url = buildGrokImageUrl(base, mode);
      const upstreamQuality = resolveGrokQuality(model, quality);
      const editImages = mode === 'edit' && Array.isArray(inputImages)
        ? inputImages.map((image) => ({
            type: 'image_url',
            url: `data:${image.mimeType};base64,${image.data}`
          }))
        : [];

      const payload = {
        model: resolveGrokImageUpstreamModel(model, options),
        prompt,
        ...(editImages.length === 1 ? { image: editImages[0] } : {}),
        ...(editImages.length > 1 ? { images: editImages } : {}),
        ...(Number(n) > 1 ? { n: Number(n) } : {}),
        ...(upstreamQuality ? { quality: upstreamQuality } : {}),
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
        const wrapped = new ImageGenerationError(
          502,
          'upstream_failed',
          `upstream fetch failed: ${String(error && error.message || error)}`
        );
        wrapped.cause = error;
        throw wrapped;
      }

      const text = await readImageGenerationResponseText(upstreamRes, options);
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
    resolveGrokQuality,
    resolveGrokImageUpstreamModel
  }
};
