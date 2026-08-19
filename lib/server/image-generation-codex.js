'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');
const { isImageGenerationModel } = require('./code-assist-image-generation');
const { isLoopbackUrl } = require('./http-utils');
const { __private: { resolveCodexUpstreamBaseUrl } } = require('./codex-adapter');
const { __private: { sanitizeAccessToken } } = require('./codex-token-refresh');

// Native strategy for codex OAuth accounts. The codex upstream (chatgpt.com
// Responses endpoint) exposes image generation through the Responses tool
// `image_generation`: the model returns a tool-call whose output embeds the
// generated picture as `{ type: 'image', url | data, mime_type }` items.
//
// OpenAI's wire parameters (n/size/quality) are NOT forwarded — the codex tool
// has no such knobs and the upstream rejects unknown fields (parameter
// stripping is part of the strategy's translation responsibility). Edit mode
// appends the source image as an `input_image` part so the prompt describes
// the desired change.

function sanitizeToolName(value) {
  return String(value || '').trim();
}

// Walk a Responses output tree and collect image-bearing items. Images appear
// either as top-level `{ type: 'image' }` items or nested inside a
// `image_generation` tool-call's `response.output` — walk both.
function extractCodexImageOutput(output, seen = new Set()) {
  const images = [];
  const queue = Array.isArray(output) ? output.slice() : [];
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const type = String(item.type || '').trim();
    if (type === 'image') {
      images.push({
        ...(item.url ? { url: String(item.url) } : {}),
        ...(item.data ? { b64_json: String(item.data) } : {}),
        ...(item.mime_type ? { mimeType: String(item.mime_type) } : {})
      });
      continue;
    }
    if (type === 'tool_call' || type === 'function_call') {
      if (item.response && typeof item.response === 'object' && Array.isArray(item.response.output)) {
        queue.push(...item.response.output);
      }
      if (item.output && Array.isArray(item.output)) queue.push(...item.output);
      continue;
    }
    if (item.content && Array.isArray(item.content)) queue.push(...item.content);
  }
  return images;
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
    supportsModel(modelId) {
      return isImageGenerationModel(modelId);
    },
    async generate(input) {
      if (typeof fetchWithTimeout !== 'function') {
        throw new ImageGenerationError(500, 'codex_transport_unavailable', 'codex transport is not configured');
      }
      const { mode, model, prompt, image, account, options } = input;
      const timeoutMs = Number(options && options.upstreamTimeoutMs) || 120000;

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
      if (!baseUrl || isLoopbackUrl(baseUrl, options && options.port)) {
        throw new ImageGenerationError(502, 'infinite_loop_detected', 'codex upstream base url is not usable');
      }
      const url = `${baseUrl.replace(/\/+$/, '')}/responses`;

      const content = [{ type: 'input_text', text: prompt }];
      if (mode === 'edit') {
        if (!image) throw new ImageGenerationError(400, 'image_required', 'image is required for image edits');
        content.push({ type: 'input_image', image_url: `data:${image.mimeType};base64,${image.data}` });
      }

      // Responses payload with the image_generation tool; wire-only params
      // (n/size/quality) are intentionally not forwarded.
      const payload = {
        model,
        input: [{ role: 'user', content }],
        tools: [{ type: 'image_generation', name: sanitizeToolName('image_generation') }]
      };

      const headers = {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-aih-account-ref': String(account && account.accountRef || ''),
        'x-aih-account-email': String(account && account.email || '')
      };
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
          readCodexErrorDetail(upstreamRes.status, json) || text.slice(0, 200)
        );
      }

      const images = extractCodexImageOutput(json && json.output);
      if (images.length === 0) {
        throw new ImageGenerationError(502, 'upstream_failed', 'codex returned no image output');
      }

      const usageInput = json.usage && typeof json.usage === 'object'
        ? { usage: json.usage, usageFormat: '', model: String(json.model || model || '').trim() }
        : null;

      return { images, usageInput, raw: json };
    }
  };
}

module.exports = {
  createCodexImageGenerationStrategy,
  __private: {
    extractCodexImageOutput,
    readCodexErrorDetail
  }
};
