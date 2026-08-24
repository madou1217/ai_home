'use strict';

const {
  runImageGeneration,
  __private: {
    buildImageGenerationRegistry,
    resolveImageFailurePolicy,
    resolveEligibleImageAccounts,
    resolveImageCapabilityError
  }
} = require('./image-generation-executor');
const { recordSuccessfulModelUsage } = require('./upstream-endpoints-usage');
const { putImageBlob } = require('./image-blob-store');
const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');

// Facade for POST /v1/images/generations and POST /v1/images/edits.
//
// Orchestrates the whole flow without owning any wire translation:
//   1. validate + normalize the OpenAI request (image-generation-request.js)
//   2. resolve the gateway provider (capability-router.js, same router the
//      chat path uses, so aliases/provider modes behave identically)
//   3. pick an account from the provider pool (account-selector.js)
//   4. resolve the provider strategy from the registry and gate capability
//   5. execute the strategy and render the OpenAI image response (b64_json by
//      default, or a local /v1/blobs/<id> url when response_format=url)
//   6. record usage, account success/failure, request log and metrics
//
// Every failure path is normalized to the OpenAI error envelope
// { error: { message, type, code } } so any OpenAI client can surface it.

const IMAGE_PATHNAMES = new Set(['/v1/images/generations', '/v1/images/edits']);

// Same-origin base for blob URLs: reuse the Host header the client actually
// used, falling back to the configured listen address.
function resolveBlobBaseUrl(req, options = {}) {
  const host = String(req && req.headers && req.headers.host || '').trim();
  if (host) return `http://${host}`;
  return `http://${String(options.host || '127.0.0.1').trim()}:${Number(options.port) || 9527}`;
}

// Render strategy images into the OpenAI /v1/images/* response body.
// b64_json stays inline (default); response_format=url stores the bytes in the
// in-memory blob store and returns a local url. Remote urls (passthrough /
// codex) pass through untouched in either mode.
function renderImageGenerationResponse(images, options = {}) {
  const responseFormat = options.responseFormat === 'url' ? 'url' : 'b64_json';
  const baseUrl = options.baseUrl || '';
  const data = (Array.isArray(images) ? images : []).map((image) => {
    const item = image && typeof image === 'object' ? image : {};
    const revisedPrompt = typeof item.revised_prompt === 'string'
      ? { revised_prompt: item.revised_prompt }
      : {};
    if (responseFormat === 'url' && item.b64_json && baseUrl) {
      const bytes = Buffer.from(String(item.b64_json), 'base64');
      const mime = String(item.mimeType || 'image/png').trim() || 'image/png';
      const id = putImageBlob(bytes, mime);
      return { url: `${baseUrl}/v1/blobs/${id}`, ...revisedPrompt };
    }
    if (item.b64_json) return { b64_json: String(item.b64_json), ...revisedPrompt };
    if (item.url) return { url: String(item.url), ...revisedPrompt };
    return {};
  });
  return {
    created: Math.floor(Date.now() / 1000),
    data
  };
}

function writeImageGenerationError(res, writeJson, error) {
  const status = Number(error && error.statusCode) || 502;
  const code = String(error && error.code || 'upstream_failed').trim();
  const message = String(error && (error.detail || error.message) || 'image generation failed').trim();
  writeJson(res, status, {
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code
    }
  });
}

/**
 * Entry point wired into v1-router's resolved-route dispatch.
 * Returns true when the request was handled (always, for image paths).
 */
async function handleImageGenerations(ctx) {
  const {
    req,
    res,
    method,
    pathname,
    options,
    state,
    requestJson,
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestMeta,
    aliasTargetProvider,
    preferModelRouting,
    aliasResolution
  } = ctx;
  if (method !== 'POST' || !IMAGE_PATHNAMES.has(pathname)) return false;

  const deps = ctx.deps || {};
  const {
    pushMetricError,
    writeJson,
    markProxyAccountSuccess,
    appendProxyRequestLog,
    recordModelUsage
  } = deps;
  const metrics = state && state.metrics ? state.metrics : {};

  const fail = (error) => {
    const failurePolicy = error && error.imageFailurePolicy
      ? error.imageFailurePolicy
      : resolveImageFailurePolicy(error, { cooldownMs });
    const failureProvider = String(error && error.imageProvider || 'image').trim() || 'image';
    if (metrics.totalFailures != null) metrics.totalFailures = Number(metrics.totalFailures) + 1;
    pushMetricError && pushMetricError(metrics, routeKey, 'image', {
      message: String(error && (error.detail || error.message) || 'image generation failed'),
      error: String(error && error.code || 'upstream_failed'),
      model: String(requestJson && requestJson.model || '')
    });
    appendProxyRequestLog && options.logRequests && appendProxyRequestLog({
      at: new Date().toISOString(),
      requestId: requestMeta && requestMeta.requestId,
      route: routeKey,
      provider: 'image',
      status: Number(error && error.statusCode) || 502,
      error: String(error && error.code || 'upstream_failed'),
      durationMs: Date.now() - (requestStartedAt || Date.now())
    });
    appendUpstreamFailureDiagnosticLog({
      options,
      appendProxyRequestLog,
      requestId: requestMeta && requestMeta.requestId,
      route: routeKey,
      provider: failureProvider,
      status: Number(error && error.statusCode) || 502,
      upstreamUrl: error && error.upstreamUrl,
      upstreamBody: error && error.upstreamBody,
      policy: failurePolicy
    });
    writeImageGenerationError(res, writeJson, error);
  };

  let execution;
  try {
    execution = await runImageGeneration({
      req,
      pathname,
      requestJson,
      options,
      state,
      cooldownMs,
      requestMeta,
      routeKey,
      requestStartedAt,
      aliasTargetProvider,
      preferModelRouting,
      aliasResolution,
      deps
    });
  } catch (error) {
    fail(error);
    return true;
  }

  const { request, provider, account, result } = execution;

  // 6. Render and send.
  const body = renderImageGenerationResponse(result.images, {
    responseFormat: request.responseFormat,
    baseUrl: resolveBlobBaseUrl(req, options)
  });
  const raw = Buffer.from(JSON.stringify(body));
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('x-aih-server-provider', provider);
  res.setHeader('x-aih-server-account-ref', String(account.accountRef || ''));
  if (account.email) res.setHeader('x-aih-server-account-email', account.email);
  res.setHeader('content-length', raw.length);
  res.end(raw);

  if (metrics.totalSuccess != null) metrics.totalSuccess = Number(metrics.totalSuccess) + 1;
  if (result.usageInput) {
    recordSuccessfulModelUsage(recordModelUsage, {
      provider,
      account,
      requestMeta,
      requestJson,
      usage: result.usageInput.usage,
      usageFormat: result.usageInput.usageFormat,
      model: result.usageInput.model || request.model,
      sourceKind: 'server_image_generation'
    });
  }
  markProxyAccountSuccess && markProxyAccountSuccess(account, { model: request.model });
  appendProxyRequestLog && options.logRequests && appendProxyRequestLog({
    at: new Date().toISOString(),
    requestId: requestMeta && requestMeta.requestId,
    route: routeKey,
    provider,
    accountRef: account.accountRef,
    status: 200,
    durationMs: Date.now() - (requestStartedAt || Date.now())
  });
  return true;
}

module.exports = {
  handleImageGenerations,
  __private: {
    buildImageGenerationRegistry,
    resolveEligibleImageAccounts,
    resolveImageCapabilityError,
    resolveBlobBaseUrl,
    renderImageGenerationResponse,
    writeImageGenerationError,
    IMAGE_PATHNAMES
  }
};
