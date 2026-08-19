'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');
const { createImageGenerationStrategyRegistry } = require('./image-generation-strategy-registry');
const { __private: { isApiKeyAccount } } = require('./image-generation-strategy-registry');
const { createUnsupportedImageGenerationStrategy } = require('./image-generation-unsupported');
const { createPassthroughImageGenerationStrategy } = require('./image-generation-passthrough');
const { createAgyGeminiImageGenerationStrategy } = require('./image-generation-agy-gemini');
const { createCodexImageGenerationStrategy } = require('./image-generation-codex');
const { createGrokImageGenerationStrategy } = require('./image-generation-grok');
const { parseImageGenerationRequest } = require('./image-generation-request');
const { resolveGatewayProvider: resolveGatewayProviderDefault } = require('./capability-router');
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

// Account failures that should cool down the (account, model) tuple.
const ACCOUNT_FAILURE_CODES = new Set(['upstream_failed', 'invalid_access_token', 'infinite_loop_detected']);

// Upstream quota/rate limits and 5xx are account-agnostic outages worth
// retrying against another account in the pool. Client errors (4xx) describe
// the request itself — retrying cannot change their outcome.
function isRetryableImageError(error) {
  const status = Number(error && error.statusCode) || 0;
  return status === 429 || status >= 500;
}

function resolveImageGenMaxAttempts(options = {}) {
  return Math.max(1, Number(options.imageGenMaxAttempts) || 3);
}

function buildImageGenerationRegistry(deps) {
  return createImageGenerationStrategyRegistry({
    agy: createAgyGeminiImageGenerationStrategy(deps),
    gemini: createAgyGeminiImageGenerationStrategy(deps),
    codex: createCodexImageGenerationStrategy(deps),
    grok: createGrokImageGenerationStrategy(deps),
    passthrough: createPassthroughImageGenerationStrategy(deps)
  });
}

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
    if (responseFormat === 'url' && item.b64_json && baseUrl) {
      const bytes = Buffer.from(String(item.b64_json), 'base64');
      const mime = String(item.mimeType || 'image/png').trim() || 'image/png';
      const id = putImageBlob(bytes, mime);
      return { url: `${baseUrl}/v1/blobs/${id}` };
    }
    if (item.b64_json) return { b64_json: String(item.b64_json) };
    if (item.url) return { url: String(item.url) };
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

function writeGatewayResolutionError(res, writeJson, result) {
  const status = Number(result && result.statusCode) || 503;
  const code = String(result && result.error || 'no_available_account').trim();
  const model = String(result && result.model || '').trim();
  const detail = String(result && result.detail || (model ? `no available account can serve model ${model}` : 'no available account'))
    .trim();
  writeJson(res, status, {
    error: {
      message: detail,
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
    chooseServerAccount,
    pushMetricError,
    writeJson,
    fetchWithTimeout,
    fetchGeminiCodeAssistGenerateContent,
    markProxyAccountFailure,
    markProxyAccountSuccess,
    appendProxyRequestLog,
    refreshCodexAccessToken,
    refreshAgyAccessToken,
    refreshGrokAccessToken,
    recordModelUsage,
    resolveGatewayProvider = resolveGatewayProviderDefault
  } = deps;
  const metrics = state && state.metrics ? state.metrics : {};

  const fail = (error) => {
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
      provider: 'image',
      status: Number(error && error.statusCode) || 502,
      upstreamUrl: error && error.upstreamUrl,
      upstreamBody: error && error.upstreamBody,
      policy: {
        kind: String(error && error.code || 'upstream_failed'),
        detail: String(error && (error.detail || error.message) || 'image generation failed')
      }
    });
    writeImageGenerationError(res, writeJson, error);
  };

  let request;
  try {
    request = parseImageGenerationRequest(requestJson || {}, pathname);
  } catch (error) {
    fail(error);
    return true;
  }

  // 1. Resolve the gateway provider with the same router the chat path uses
  //    (aliases, provider mode, account availability all behave identically).
  const gatewayResult = resolveGatewayProvider({
    options,
    state,
    requestJson: { model: request.model },
    headers: req && req.headers,
    clientProtocol: 'openai_images',
    aliasTargetProvider,
    preferModelRouting,
    aliasResolution
  });
  const provider = String(gatewayResult && gatewayResult.provider || '').trim();
  if (!provider) {
    fail(new ImageGenerationError(
      Number(gatewayResult && gatewayResult.statusCode) || 503,
      String(gatewayResult && gatewayResult.error || 'no_available_account'),
      String(gatewayResult && gatewayResult.detail || `no available account can serve model ${request.model}`)
    ));
    return true;
  }

  // 2. Pick an account from the provider pool.
  const pool = state && state.accounts && Array.isArray(state.accounts[provider]) ? state.accounts[provider] : [];
  if (pool.length === 0) {
    fail(new ImageGenerationError(503, 'no_available_account', `no available ${provider} account`));
    return true;
  }

  // OAuth-only pools can only be served by a registered strategy: fail fast.
  const registry = buildImageGenerationRegistry(deps);
  const firstAccount = pool[0] && typeof pool[0] === 'object' ? pool[0] : null;
  if (!isApiKeyAccount(firstAccount) && !registry.has(provider)) {
    fail(new ImageGenerationError(400, 'unsupported_image_provider', `provider ${provider} has no image generation support`));
    return true;
  }

  // 3/4/5. Try accounts in the pool until one succeeds. Each retryable
  // failure (429 / 5xx) cools down that account and moves to the next one,
  // so a single request survives a quota-exhausted or channel-less account
  // instead of failing on the first pick.
  const maxAttempts = resolveImageGenMaxAttempts(options);
  const attemptedRefs = new Set();
  let account = null;
  let result = null;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    account = chooseServerAccount(pool, state, `image-gen:${provider}`, {
      provider,
      model: request.model,
      sessionKey: String(requestMeta && requestMeta.sessionKey || '').trim(),
      excludeAccountRefs: attemptedRefs
    });
    if (!account) break;
    attemptedRefs.add(String(account.accountRef || ''));

    // Resolve the strategy for this account (api-key accounts use
    // passthrough, OAuth accounts use their native strategy) and gate
    // capability. A model-gate failure is not account-specific — fail fast.
    const strategy = registry.resolve(provider, account) || createUnsupportedImageGenerationStrategy(provider);
    if (!strategy.supportsModel(request.model)) {
      fail(new ImageGenerationError(
        400,
        strategy.kind === 'unsupported' ? 'unsupported_image_provider' : 'unsupported_model_for_images',
        strategy.kind === 'unsupported'
          ? `provider ${provider} has no image generation support`
          : `model ${request.model} is not supported for image generation`
      ));
      return true;
    }

    try {
      result = await strategy.generate({
        mode: request.mode,
        model: request.model,
        prompt: request.prompt,
        ...(request.image ? { image: request.image } : {}),
        ...(request.mask ? { mask: request.mask } : {}),
        account,
        options,
        state,
        requestMeta,
        requestJson
      });
      break;
    } catch (error) {
      lastError = error;
      appendUpstreamFailureDiagnosticLog({
        options,
        appendProxyRequestLog,
        requestId: requestMeta && requestMeta.requestId,
        route: routeKey,
        provider: 'image',
        status: Number(error && error.statusCode) || 502,
        upstreamUrl: error && error.upstreamUrl,
        upstreamBody: error && error.upstreamBody,
        policy: {
          kind: String(error && error.code || 'upstream_failed'),
          detail: String(error && (error.detail || error.message) || 'image generation failed')
        },
        account,
        attempt,
        maxAttempts
      });
      if (ACCOUNT_FAILURE_CODES.has(String(error && error.code || ''))) {
        markProxyAccountFailure && markProxyAccountFailure(account, String(error.code || 'upstream_failed'), cooldownMs, options.failureThreshold, { model: request.model });
      }
      if (!isRetryableImageError(error)) {
        fail(error);
        return true;
      }
    }
  }

  if (!result) {
    fail(lastError || new ImageGenerationError(
      503,
      'no_available_account',
      `no healthy ${provider} account can serve model ${request.model}`
    ));
    return true;
  }

  // 6. Render and send.
  const body = renderImageGenerationResponse(result.images, {
    responseFormat: request.responseFormat,
    baseUrl: resolveBlobBaseUrl(req, options)
  });
  const raw = Buffer.from(JSON.stringify(body));
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
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
    resolveBlobBaseUrl,
    renderImageGenerationResponse,
    writeImageGenerationError,
    writeGatewayResolutionError,
    IMAGE_PATHNAMES
  }
};
