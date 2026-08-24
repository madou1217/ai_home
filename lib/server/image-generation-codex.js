'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');
const { getNativeImageCapabilities } = require('./image-generation-model-specs');
const { readImageGenerationResponseText } = require('./image-generation-response');
const { isCurrentImageGatewayUrl } = require('./image-generation-url-policy');
const { __private: { resolveCodexUpstreamBaseUrl } } = require('./codex-adapter');
const { __private: { sanitizeAccessToken } } = require('./codex-token-refresh');

// Native strategy for Codex OAuth accounts. Codex 0.142.3+ executes its
// image-generation extension through the dedicated ChatGPT Images endpoints.
// Keep this wire contract aligned with the pinned Codex source: gpt-image-2,
// JSON edit references, and the controls represented by codex-api's
// ImageGenerationRequest / ImageEditRequest.

const CODEX_IMAGE_MODEL = 'gpt-image-2';

function imageDataUrl(image) {
  return image ? `data:${image.mimeType};base64,${image.data}` : '';
}

function buildCodexImageUrl(baseUrl, mode) {
  const suffix = mode === 'edit' ? 'edits' : 'generations';
  return `${String(baseUrl || '').trim().replace(/\/+$/, '')}/images/${suffix}`;
}

function buildCodexImagePayload(input = {}) {
  const payload = {
    prompt: String(input.prompt || '').trim(),
    background: input.background || 'auto',
    model: CODEX_IMAGE_MODEL,
    ...(Number(input.n) > 1 ? { n: Number(input.n) } : {}),
    quality: input.quality || 'auto',
    size: input.size || 'auto'
  };
  if (input.mode === 'edit') {
    payload.images = (Array.isArray(input.images) ? input.images : [])
      .map((image) => ({ image_url: imageDataUrl(image) }));
  }
  return payload;
}

function extractCodexDirectImages(json) {
  return (Array.isArray(json && json.data) ? json.data : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      ...(item.b64_json ? { b64_json: String(item.b64_json) } : {}),
      ...(item.url ? { url: String(item.url) } : {}),
      ...(typeof item.revised_prompt === 'string'
        ? { revised_prompt: item.revised_prompt }
        : {})
    }));
}

function readCodexErrorDetail(status, json) {
  const error = json && json.error && typeof json.error === 'object' ? json.error : {};
  return String(error.message || error.detail || `upstream returned HTTP ${status}`).trim();
}

function createCodexImageGenerationStrategy(deps = {}) {
  const fetchWithTimeout = deps.fetchWithTimeout;
  const refreshCodexAccessToken = deps.refreshCodexAccessToken;
  return {
    provider: 'codex',
    kind: 'native',
    capabilities: getNativeImageCapabilities('codex'),
    supportsModel(modelId) {
      return String(modelId || '').trim().toLowerCase() === CODEX_IMAGE_MODEL;
    },
    async generate(input) {
      if (typeof fetchWithTimeout !== 'function') {
        throw new ImageGenerationError(500, 'codex_transport_unavailable', 'codex transport is not configured');
      }
      const {
        mode,
        prompt,
        n,
        size,
        quality,
        images: inputImages,
        background,
        account,
        options,
        requestMeta
      } = input;
      const timeoutMs = Math.max(Number(options && options.upstreamTimeoutMs) || 0, 120000);

      // Best-effort token refresh; a stale token surfaces as 401/403 below.
      if (typeof refreshCodexAccessToken === 'function') {
        try {
          await refreshCodexAccessToken(account, {
            force: false,
            timeoutMs,
            proxyUrl: options && options.proxyUrl,
            noProxy: options && options.noProxy
          }, { fetchWithTimeout });
        } catch (_error) {}
      }

      const accessToken = sanitizeAccessToken(account && account.accessToken);
      if (!accessToken) {
        throw new ImageGenerationError(400, 'invalid_access_token', 'codex account has no usable access token');
      }

      const baseUrl = resolveCodexUpstreamBaseUrl(options || {}, account);
      if (!baseUrl || isCurrentImageGatewayUrl(baseUrl, options && options.port)) {
        throw new ImageGenerationError(502, 'infinite_loop_detected', 'codex upstream base url is not usable');
      }
      if (mode === 'edit') {
        const inputs = Array.isArray(inputImages) ? inputImages : [];
        if (inputs.length < 1) throw new ImageGenerationError(400, 'image_required', 'image is required for image edits');
      }
      const url = buildCodexImageUrl(baseUrl, mode);
      const payload = buildCodexImagePayload({
        mode,
        prompt,
        n,
        size,
        quality,
        images: inputImages,
        background
      });

      const headers = {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
        originator: 'codex_cli_rs',
        'x-aih-account-ref': String(account && account.accountRef || ''),
        'x-aih-account-email': String(account && account.email || '')
      };
      const turnId = String(requestMeta && requestMeta.requestId || '').trim();
      if (turnId) headers['x-codex-image-turn-id'] = turnId;
      if (account && account.upstreamAccountId) {
        headers['chatgpt-account-id'] = String(account.upstreamAccountId);
      }

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
          readCodexErrorDetail(upstreamRes.status, json) || text.slice(0, 200)
        );
        // Carry the raw upstream body on the error so the facade's failure
        // diagnostics can persist it for offline debugging.
        if (text) err.upstreamBody = text.slice(0, 500);
        throw err;
      }

      const images = extractCodexDirectImages(json);
      const usageInput = json.usage && typeof json.usage === 'object'
        ? { usage: json.usage, usageFormat: '', model: CODEX_IMAGE_MODEL }
        : null;

      if (images.length === 0) {
        throw new ImageGenerationError(502, 'upstream_failed', 'codex returned no image output');
      }

      return { images, usageInput, raw: json };
    }
  };
}

module.exports = {
  createCodexImageGenerationStrategy,
  __private: {
    buildCodexImagePayload,
    buildCodexImageUrl,
    extractCodexDirectImages,
    imageDataUrl,
    readCodexErrorDetail
  }
};
