'use strict';

const {
  decodeCanonicalBase64,
  detectImageMime: detectImageMimeBytes,
  normalizeImageMime
} = require('./image-data');
const { parseImageDataUrl, parseImageGenerationRequest } = require('./image-generation-request');
const { runImageGeneration } = require('./image-generation-executor');
const { listImageStudioModels } = require('./image-studio-model-catalog');
const { fetchRemoteImage } = require('./image-studio-remote-image');
const { recordSuccessfulModelUsage } = require('./upstream-endpoints-usage');
const { resolveProviderUpstream } = require('./upstream-endpoints-path');
const { __private: { MAX_STUDIO_ASSET_BYTES } } = require('./image-studio-store');

const IMAGE_STUDIO_BASE_PATH = '/v0/webui/studio/image';
const IMAGE_STUDIO_BODY_BYTES = 16 * 1024 * 1024;
const STUDIO_ACCOUNT_FAILURE_CODES = new Set([
  'empty_image_output',
  'image_asset_fetch_failed',
  'image_asset_host_resolution_failed',
  'image_asset_read_timeout',
  'image_asset_redirect_invalid',
  'image_asset_redirect_limit',
  'image_asset_too_large',
  'image_asset_url_blocked',
  'image_output_missing',
  'invalid_image_output',
  'invalid_image_output_url'
]);

function createRouteError(statusCode, code, detail) {
  const error = new Error(String(detail || code || 'image_studio_error'));
  error.statusCode = Number(statusCode) || 500;
  error.code = String(code || 'image_studio_error');
  error.detail = String(detail || error.message);
  return error;
}

async function readJsonBody(ctx, maxBytes = 1024 * 1024) {
  const result = await ctx.readRequestBody(ctx.req, { maxBytes }).catch((error) => ({ __error: error }));
  if (!result || result.__error) {
    const error = result && result.__error;
    if (error && error.code === 'request_body_too_large') {
      throw createRouteError(413, 'request_body_too_large', 'request body is too large');
    }
    throw createRouteError(400, 'invalid_request_body', 'request body could not be read');
  }
  try {
    return result.length > 0 ? JSON.parse(result.toString('utf8')) : {};
  } catch (_error) {
    throw createRouteError(400, 'invalid_json', 'request body must be valid JSON');
  }
}

function assetUrl(sessionId, assetId) {
  return `${IMAGE_STUDIO_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(assetId)}`;
}

function serializeSession(session) {
  return {
    version: Number(session && session.version) || 1,
    id: String(session && session.id || ''),
    title: String(session && session.title || ''),
    createdAt: Number(session && session.createdAt) || 0,
    updatedAt: Number(session && session.updatedAt) || 0,
    activeRevisionId: String(session && session.activeRevisionId || ''),
    revisions: (Array.isArray(session && session.revisions) ? session.revisions : []).map((revision) => ({
      ...revision,
      outputAssetIds: Array.isArray(revision && revision.outputAssetIds) ? revision.outputAssetIds : []
    })),
    assets: (Array.isArray(session && session.assets) ? session.assets : []).map((asset) => ({
      id: String(asset && asset.id || ''),
      revisionId: String(asset && asset.revisionId || ''),
      role: String(asset && asset.role || ''),
      mimeType: String(asset && asset.mimeType || 'image/png'),
      byteLength: Number(asset && asset.byteLength) || 0,
      createdAt: Number(asset && asset.createdAt) || 0,
      ...(typeof (asset && asset.revisedPrompt) === 'string' && asset.revisedPrompt.trim()
        ? { revisedPrompt: asset.revisedPrompt }
        : {}),
      url: assetUrl(session.id, asset.id)
    }))
  };
}

function serializeSessionSummary(summary) {
  return {
    ...summary,
    previewUrl: summary.previewAssetId ? assetUrl(summary.id, summary.previewAssetId) : ''
  };
}

function normalizeModelSelection(body, models) {
  const modelKey = String(body && body.modelKey || '').trim();
  let provider = String(body && body.provider || '').trim().toLowerCase();
  let model = String(body && body.model || '').trim();
  if (modelKey && (!provider || !model)) {
    const separator = modelKey.indexOf(':');
    if (separator > 0) {
      provider = provider || modelKey.slice(0, separator).trim().toLowerCase();
      model = model || modelKey.slice(separator + 1).trim();
    }
  }
  const key = `${provider}:${model}`;
  const selected = (Array.isArray(models) ? models : []).find((entry) => entry && entry.key === key);
  if (!selected) {
    throw createRouteError(400, 'image_studio_model_not_found', `image model ${key} is not available in the Studio catalog`);
  }
  return selected;
}

function storedImageToParsed(store, sessionId, assetId) {
  if (!assetId) return null;
  const stored = store.readAsset(sessionId, assetId);
  return {
    mimeType: stored.asset.mimeType,
    data: stored.bytes.toString('base64')
  };
}

function parsedImageToStoreInput(parsed) {
  if (!parsed) return null;
  return {
    mimeType: parsed.mimeType,
    bytes: Buffer.from(parsed.data, 'base64')
  };
}

function toDataUrl(image) {
  return image ? `data:${image.mimeType};base64,${image.data}` : '';
}

function normalizeStudioSources(body) {
  const explicit = Array.isArray(body && body.sources) ? body.sources : null;
  const hasLegacy = Boolean(body && (body.sourceAssetId || body.image));
  if (explicit && hasLegacy) {
    throw createRouteError(400, 'ambiguous_image_input', 'choose either sources or legacy image input fields');
  }
  if (explicit) return explicit;
  if (!hasLegacy) return [];
  return [{
    ...(body.sourceAssetId ? { assetId: body.sourceAssetId } : {}),
    ...(body.image ? { image: body.image } : {})
  }];
}

function detectImageMime(bytes, hint) {
  const detectedMimeType = detectImageMimeBytes(bytes);
  if (!detectedMimeType) {
    throw createRouteError(502, 'invalid_image_output', 'generated image output is not a supported image');
  }
  const declaredMimeType = normalizeImageMime(hint);
  if (hint && (!declaredMimeType || declaredMimeType !== detectedMimeType)) {
    throw createRouteError(502, 'invalid_image_output', 'generated image mime type does not match its bytes');
  }
  return detectedMimeType;
}

function assertAssetSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1) {
    throw createRouteError(502, 'empty_image_output', 'generated image output is empty');
  }
  if (bytes.length > MAX_STUDIO_ASSET_BYTES) {
    throw createRouteError(413, 'image_asset_too_large', 'generated image exceeds 20 MiB limit');
  }
  return bytes;
}

function resolveTrustedImageOrigins(execution, options) {
  if (!execution || !execution.strategy || execution.strategy.kind !== 'passthrough') return [];
  const upstream = resolveProviderUpstream(options || {}, execution.provider, execution.account);
  try {
    const url = new URL(String(upstream || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
    return [url.origin];
  } catch (_error) {
    return [];
  }
}

async function readRemoteImage(item, ctx, execution) {
  return fetchRemoteImage({
    url: item && item.url,
    fetchWithTimeout: ctx.deps && ctx.deps.fetchWithTimeout,
    maxBytes: MAX_STUDIO_ASSET_BYTES,
    timeoutMs: Math.max(Number(ctx.options && ctx.options.upstreamTimeoutMs) || 0, 120000),
    trustedOrigins: resolveTrustedImageOrigins(execution, ctx.options),
    resolveHost: ctx.deps && ctx.deps.resolveImageAssetHost,
    proxyOptions: {
      proxyUrl: ctx.options && ctx.options.proxyUrl,
      noProxy: ctx.options && ctx.options.noProxy
    }
  });
}

async function materializeImages(images, ctx, execution) {
  const list = Array.isArray(images) ? images : [];
  const output = [];
  for (const item of list) {
    const revisedPrompt = typeof (item && item.revised_prompt) === 'string'
      ? item.revised_prompt.trim()
      : '';
    if (item && item.b64_json) {
      const decoded = decodeCanonicalBase64(item.b64_json);
      if (!decoded) {
        throw createRouteError(502, 'invalid_image_output', 'generated image output has invalid base64');
      }
      const bytes = assertAssetSize(decoded.bytes);
      output.push({
        bytes,
        mimeType: detectImageMime(bytes, item.mimeType),
        ...(revisedPrompt ? { revisedPrompt } : {})
      });
    } else if (item && item.url) {
      output.push({
        ...(await readRemoteImage(item, ctx, execution)),
        ...(revisedPrompt ? { revisedPrompt } : {})
      });
    }
  }
  if (output.length < 1) {
    throw createRouteError(502, 'image_output_missing', 'image generation returned no persistent output');
  }
  return output;
}

function resolveDefaultModelKey(models) {
  const list = Array.isArray(models) ? models : [];
  return String(
    list.find((model) => Number(model && model.availableAccountCount) > 0)?.key
    || list[0]?.key
    || ''
  );
}

function requestIdFromResponse(res) {
  return String(res && typeof res.getHeader === 'function' && res.getHeader('x-aih-request-id') || '').trim();
}

function recordStudioUpstreamUsage(ctx, execution, requestJson) {
  const { deps } = ctx;
  const { provider, account, result, request } = execution;
  if (result.usageInput) {
    try {
      recordSuccessfulModelUsage(deps.recordModelUsage, {
        provider,
        account,
        requestMeta: { requestId: requestIdFromResponse(ctx.res), sessionKey: requestJson.session_id },
        requestJson,
        usage: result.usageInput.usage,
        usageFormat: result.usageInput.usageFormat,
        model: result.usageInput.model || request.model,
        sourceKind: 'server_image_studio'
      });
    } catch (_error) {}
  }
}

function recordStudioAccountSuccess(ctx, execution) {
  try {
    ctx.deps.markProxyAccountSuccess
      && ctx.deps.markProxyAccountSuccess(execution.account, { model: execution.request.model });
  } catch (_error) {}
}

function recordStudioAccountFailure(ctx, execution, error) {
  const code = String(error && error.code || '');
  if (!execution || !STUDIO_ACCOUNT_FAILURE_CODES.has(code)) return;
  try {
    ctx.deps.markProxyAccountFailure && ctx.deps.markProxyAccountFailure(
      execution.account,
      code,
      ctx.cooldownMs,
      ctx.options && ctx.options.failureThreshold,
      { model: execution.request.model }
    );
  } catch (_error) {}
}

function observeSafely(callback) {
  try {
    callback();
  } catch (_error) {}
}

function recordStudioSuccess(ctx, execution, startedAt) {
  const metrics = ctx.state && ctx.state.metrics;
  observeSafely(() => {
    if (metrics && metrics.totalSuccess != null) metrics.totalSuccess = Number(metrics.totalSuccess) + 1;
  });
  observeSafely(() => {
    ctx.deps.appendProxyRequestLog && ctx.options && ctx.options.logRequests && ctx.deps.appendProxyRequestLog({
      at: new Date().toISOString(),
      requestId: requestIdFromResponse(ctx.res),
      route: 'POST /v0/webui/studio/image/sessions/:id/runs',
      provider: execution.provider,
      accountRef: execution.account.accountRef,
      status: 200,
      durationMs: Date.now() - startedAt
    });
  });
}

function recordStudioFailure(ctx, error, requestJson, startedAt) {
  const metrics = ctx.state && ctx.state.metrics;
  observeSafely(() => {
    if (metrics && metrics.totalFailures != null) metrics.totalFailures = Number(metrics.totalFailures) + 1;
  });
  observeSafely(() => {
    ctx.deps.pushMetricError && ctx.deps.pushMetricError(metrics, 'POST /v0/webui/studio/image/sessions/:id/runs', 'image', {
      message: String(error && (error.detail || error.message) || 'image generation failed'),
      error: String(error && error.code || 'image_generation_failed'),
      model: String(requestJson && requestJson.model || '')
    });
  });
  observeSafely(() => {
    ctx.deps.appendProxyRequestLog && ctx.options && ctx.options.logRequests && ctx.deps.appendProxyRequestLog({
      at: new Date().toISOString(),
      requestId: requestIdFromResponse(ctx.res),
      route: 'POST /v0/webui/studio/image/sessions/:id/runs',
      provider: String(requestJson && requestJson.provider || 'image'),
      status: Number(error && error.statusCode) || 500,
      error: String(error && error.code || 'image_generation_failed'),
      durationMs: Date.now() - startedAt
    });
  });
}

function writeError(ctx, error) {
  ctx.writeJson(ctx.res, Number(error && error.statusCode) || 500, {
    ok: false,
    error: String(error && error.code || 'image_studio_error'),
    detail: String(error && (error.detail || error.message) || 'image Studio request failed')
  });
}

async function handleRunRequest(ctx, sessionId) {
  const startedAt = Date.now();
  const store = ctx.deps.imageStudioStore;
  let revisionId = '';
  let executionJson = null;
  let execution = null;
  try {
    const body = await readJsonBody(ctx, IMAGE_STUDIO_BODY_BYTES);
    const models = listImageStudioModels(ctx.state);
    const selected = normalizeModelSelection(body, models);
    const mode = body.mode === 'edit' ? 'edit' : 'generation';
    const sourceInputs = normalizeStudioSources(body);
    if (mode === 'generation' && (sourceInputs.length > 0 || body.mask || body.maskAssetId)) {
      throw createRouteError(400, 'image_input_requires_edit', 'source images and masks require edit mode');
    }
    if (body.maskAssetId && body.mask) {
      throw createRouteError(400, 'ambiguous_mask_input', 'choose either maskAssetId or mask, not both');
    }

    const sources = sourceInputs.map((source) => {
      const assetId = String(source && source.assetId || '').trim();
      const imageValue = source && source.image;
      if (assetId && imageValue) {
        throw createRouteError(400, 'ambiguous_image_input', 'each source must use either assetId or image');
      }
      if (assetId) {
        return { assetId, parsed: storedImageToParsed(store, sessionId, assetId) };
      }
      if (imageValue) {
        return { image: imageValue, parsed: parseImageDataUrl(imageValue) };
      }
      throw createRouteError(400, 'invalid_image_source', 'each source must include assetId or image');
    });
    let maskImage = null;
    if (body.maskAssetId) maskImage = storedImageToParsed(store, sessionId, body.maskAssetId);
    else if (body.mask) maskImage = parseImageDataUrl(body.mask);

    executionJson = {
      provider: selected.provider,
      model: selected.id,
      prompt: String(body.prompt || '').trim(),
      n: body.n == null ? 1 : body.n,
      ...(body.size ? { size: body.size } : {}),
      ...(body.quality ? { quality: body.quality } : {}),
      ...(body.background ? { background: body.background } : {}),
      ...(body.output_format ? { output_format: body.output_format } : {}),
      ...(body.output_compression != null ? { output_compression: body.output_compression } : {}),
      ...(body.moderation ? { moderation: body.moderation } : {}),
      response_format: 'b64_json',
      session_id: sessionId,
      ...(sources.length > 0
        ? { images: sources.map((source) => ({ image_url: toDataUrl(source.parsed) })) }
        : {}),
      ...(maskImage ? { mask: toDataUrl(maskImage) } : {})
    };
    const pathname = mode === 'edit' ? '/v1/images/edits' : '/v1/images/generations';
    const parsedRequest = parseImageGenerationRequest(executionJson, pathname, {
      // Only assets already accepted by the durable Studio store may use its
      // 20 MiB ceiling. Fresh browser uploads keep the public 4 MiB boundary,
      // including mixed stored-source + uploaded-mask requests.
      maxImageBytes: sources.some((source) => source.assetId) ? MAX_STUDIO_ASSET_BYTES : undefined,
      maxMaskBytes: body.maskAssetId ? MAX_STUDIO_ASSET_BYTES : undefined
    });
    const started = store.beginRevision(sessionId, {
      mode,
      provider: selected.provider,
      model: selected.id,
      modelKey: selected.key,
      prompt: parsedRequest.prompt,
      parentRevisionId: body.parentRevisionId,
      sources: sources.map((source) => (source.assetId
        ? { assetId: source.assetId }
        : { image: parsedImageToStoreInput(source.parsed) })),
      maskAssetId: body.maskAssetId,
      maskImage: body.mask ? parsedImageToStoreInput(maskImage) : null,
      parameters: {
        n: parsedRequest.n,
        size: parsedRequest.size,
        quality: parsedRequest.quality,
        background: parsedRequest.background,
        outputFormat: parsedRequest.outputFormat,
        outputCompression: parsedRequest.outputCompression,
        moderation: parsedRequest.moderation
      }
    });
    revisionId = started.revision.id;

    const requestMeta = {
      requestId: requestIdFromResponse(ctx.res),
      sessionKey: sessionId
    };
    execution = await runImageGeneration({
      request: parsedRequest,
      pathname,
      requestJson: executionJson,
      headers: ctx.req && ctx.req.headers,
      options: ctx.options,
      state: ctx.state,
      cooldownMs: ctx.cooldownMs,
      requestMeta,
      routeKey: 'POST /v0/webui/studio/image/sessions/:id/runs',
      requestStartedAt: startedAt,
      deps: ctx.deps
    });
    recordStudioUpstreamUsage(ctx, execution, executionJson);
    const images = await materializeImages(execution.result.images, ctx, execution);
    recordStudioAccountSuccess(ctx, execution);
    const completedRevisionId = revisionId;
    const completed = store.completeRevision(sessionId, revisionId, {
      accountRef: execution.account.accountRef,
      images
    });
    revisionId = '';
    recordStudioSuccess(ctx, execution, startedAt);
    ctx.writeJson(ctx.res, 200, {
      ok: true,
      session: serializeSession(completed.session),
      revisionId: completedRevisionId
    });
  } catch (error) {
    if (revisionId) {
      try {
        store.failRevision(sessionId, revisionId, error);
      } catch (_storeError) {}
    }
    recordStudioAccountFailure(ctx, execution, error);
    recordStudioFailure(ctx, error, executionJson, startedAt);
    writeError(ctx, error);
  }
  return true;
}

async function handleWebUiImageStudioRoutes(ctx) {
  const { method, pathname, deps } = ctx;
  const store = deps && deps.imageStudioStore;
  if (!pathname.startsWith(IMAGE_STUDIO_BASE_PATH)) return false;
  if (!store) {
    writeError(ctx, createRouteError(503, 'image_studio_store_unavailable', 'image Studio store is not configured'));
    return true;
  }

  if (method === 'GET' && pathname === `${IMAGE_STUDIO_BASE_PATH}/models`) {
    const models = listImageStudioModels(ctx.state);
    ctx.writeJson(ctx.res, 200, {
      ok: true,
      models,
      defaultModelKey: resolveDefaultModelKey(models)
    });
    return true;
  }

  if (pathname === `${IMAGE_STUDIO_BASE_PATH}/sessions`) {
    if (method === 'GET') {
      ctx.writeJson(ctx.res, 200, {
        ok: true,
        sessions: store.listSessions().map(serializeSessionSummary)
      });
      return true;
    }
    if (method === 'POST') {
      try {
        const body = await readJsonBody(ctx);
        const session = store.createSession({ title: body.title });
        ctx.writeJson(ctx.res, 201, { ok: true, session: serializeSession(session) });
      } catch (error) {
        writeError(ctx, error);
      }
      return true;
    }
  }

  const runMatch = pathname.match(/^\/v0\/webui\/studio\/image\/sessions\/(img_[0-9a-f-]{36})\/runs$/i);
  if (method === 'POST' && runMatch) return handleRunRequest(ctx, runMatch[1]);

  const assetMatch = pathname.match(/^\/v0\/webui\/studio\/image\/sessions\/(img_[0-9a-f-]{36})\/assets\/(asset_[0-9a-f-]{36})$/i);
  if (method === 'GET' && assetMatch) {
    try {
      const stored = store.readAsset(assetMatch[1], assetMatch[2]);
      ctx.res.writeHead(200, {
        'content-type': stored.asset.mimeType,
        'content-length': stored.bytes.length,
        'cache-control': 'private, max-age=31536000, immutable',
        'content-disposition': `inline; filename="${stored.asset.id}"`,
        'x-content-type-options': 'nosniff'
      });
      ctx.res.end(stored.bytes);
    } catch (error) {
      writeError(ctx, error);
    }
    return true;
  }

  const sessionMatch = pathname.match(/^\/v0\/webui\/studio\/image\/sessions\/(img_[0-9a-f-]{36})$/i);
  if (sessionMatch) {
    try {
      if (method === 'GET') {
        ctx.writeJson(ctx.res, 200, { ok: true, session: serializeSession(store.getSession(sessionMatch[1])) });
        return true;
      }
      if (method === 'PATCH') {
        const body = await readJsonBody(ctx);
        const session = store.renameSession(sessionMatch[1], body.title);
        ctx.writeJson(ctx.res, 200, { ok: true, session: serializeSession(session) });
        return true;
      }
      if (method === 'DELETE') {
        const session = store.deleteSession(sessionMatch[1]);
        ctx.writeJson(ctx.res, 200, { ok: true, deletedSessionId: session.id });
        return true;
      }
    } catch (error) {
      writeError(ctx, error);
      return true;
    }
  }

  return false;
}

module.exports = {
  handleWebUiImageStudioRoutes,
  __private: {
    IMAGE_STUDIO_BODY_BYTES,
    STUDIO_ACCOUNT_FAILURE_CODES,
    assetUrl,
    detectImageMime,
    materializeImages,
    normalizeModelSelection,
    resolveDefaultModelKey,
    resolveTrustedImageOrigins,
    serializeSession,
    serializeSessionSummary,
    normalizeStudioSources
  }
};
