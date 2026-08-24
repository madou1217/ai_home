'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');
const { createImageGenerationStrategyRegistry } = require('./image-generation-strategy-registry');
const { createUnsupportedImageGenerationStrategy } = require('./image-generation-unsupported');
const { createPassthroughImageGenerationStrategy } = require('./image-generation-passthrough');
const { createAgyGeminiImageGenerationStrategy } = require('./image-generation-agy-gemini');
const { createCodexImageGenerationStrategy } = require('./image-generation-codex');
const { createGrokImageGenerationStrategy } = require('./image-generation-grok');
const { parseImageGenerationRequest } = require('./image-generation-request');
const { normalizeImageGenerationResult } = require('./image-generation-output');
const { resolveGatewayProvider: resolveGatewayProviderDefault } = require('./capability-router');
const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { applyAccountFailurePolicy } = require('./account-runtime-state');
const { createRequestAccountFailureRecorder } = require('./request-account-failure-recorder');
const {
  resolveAccountEgressRequestOptions: resolveAccountEgressRequestOptionsDefault
} = require('./account-egress-request-options');

const ACCOUNT_FAILURE_CODES = new Set([
  'upstream_failed',
  'invalid_access_token',
  'infinite_loop_detected',
  'account_base_url_missing',
  'gemini_code_assist_not_applicable',
  'invalid_image_output',
  'invalid_image_output_url',
  'image_output_missing',
  'upstream_response_too_large'
]);

const RETRYABLE_ACCOUNT_FAILURE_CODES = new Set([
  'invalid_access_token',
  'infinite_loop_detected',
  'account_base_url_missing',
  'gemini_code_assist_not_applicable',
  'invalid_image_output',
  'invalid_image_output_url',
  'image_output_missing',
  'upstream_response_too_large'
]);

const MODEL_SCOPED_IMAGE_FAILURE_CODES = new Set([
  'invalid_image_output',
  'invalid_image_output_url',
  'image_output_missing',
  'upstream_response_too_large'
]);

function resolveWrappedUpstreamStatus(error) {
  const causeCode = String(error && error.cause && error.cause.code || '').trim();
  const httpMatch = /^HTTP_(\d{3})$/i.exec(causeCode);
  if (httpMatch) return Number(httpMatch[1]);
  if (error && error.cause) return 0;
  return Number(error && error.statusCode) || 0;
}

function resolveImageFailurePolicy(error, input = {}) {
  const code = String(error && error.code || 'upstream_failed').trim() || 'upstream_failed';
  const detail = String(error && (error.detail || error.message) || 'image generation failed').trim();
  const statusCode = code === 'invalid_access_token'
    ? 401
    : resolveWrappedUpstreamStatus(error);

  if (code === 'upstream_failed' || code === 'invalid_access_token') {
    return classifyUpstreamFailure({
      provider: String(input.provider || '').trim().toLowerCase(),
      statusCode,
      body: error && error.upstreamBody,
      error: statusCode > 0 ? undefined : error && (error.cause || error),
      detail,
      defaultCooldownMs: input.cooldownMs
    });
  }

  const retryable = RETRYABLE_ACCOUNT_FAILURE_CODES.has(code)
    || statusCode === 429
    || statusCode >= 500;
  return {
    kind: code,
    retryable,
    shouldMarkFailure: ACCOUNT_FAILURE_CODES.has(code),
    shouldRetryAnotherAccount: retryable,
    shouldPassthroughToClient: true,
    failureThreshold: Math.max(1, Number(input.failureThreshold) || 1),
    cooldownMs: Math.max(0, Number(input.cooldownMs) || 0),
    clientStatusCode: statusCode || Number(error && error.statusCode) || 502,
    failureReason: code,
    detail,
    scope: MODEL_SCOPED_IMAGE_FAILURE_CODES.has(code) ? 'model' : 'account',
    shouldUnbindSession: false
  };
}

function resolveImageGenMaxAttempts(options = {}) {
  return Math.max(1, Number(options.imageGenMaxAttempts) || 3);
}

function observeSafely(callback) {
  try {
    callback();
  } catch (_error) {}
}

function buildImageGenerationRegistry(deps) {
  return createImageGenerationStrategyRegistry({
    agy: createAgyGeminiImageGenerationStrategy(deps, 'agy'),
    gemini: createAgyGeminiImageGenerationStrategy(deps, 'gemini'),
    codex: createCodexImageGenerationStrategy(deps),
    grok: createGrokImageGenerationStrategy(deps),
    passthrough: createPassthroughImageGenerationStrategy(deps)
  });
}

function resolveImageCapabilityError(strategy, request) {
  const resolvedCapabilities = strategy && typeof strategy.capabilitiesForModel === 'function'
    ? strategy.capabilitiesForModel(request && request.model)
    : strategy && strategy.capabilities;
  const capabilities = resolvedCapabilities && typeof resolvedCapabilities === 'object'
    ? resolvedCapabilities
    : {};
  const provider = String(strategy && strategy.provider || 'provider').trim() || 'provider';
  if (request.mode === 'generation' && capabilities.generation === false) {
    return new ImageGenerationError(400, 'unsupported_image_generation', `${provider} does not support image generation`);
  }
  if (request.mode === 'edit' && capabilities.edit === false) {
    return new ImageGenerationError(400, 'unsupported_image_edit', `${provider} does not support image edits`);
  }
  const imageCount = Array.isArray(request.images) ? request.images.length : 0;
  const maxInputImages = Math.max(1, Number(capabilities.maxInputImages) || 1);
  if (imageCount > maxInputImages) {
    return new ImageGenerationError(
      400,
      'unsupported_image_input_count',
      `${provider} supports at most ${maxInputImages} input image${maxInputImages === 1 ? '' : 's'}`
    );
  }
  if (request.mask && capabilities.mask !== true) {
    return new ImageGenerationError(400, 'unsupported_image_mask', `${provider} does not support image masks`);
  }
  if (Number(request.n) > 1 && capabilities.multiple !== true) {
    return new ImageGenerationError(400, 'unsupported_image_count', `${provider} does not support multiple image outputs`);
  }
  if (request.size && request.size !== 'auto' && capabilities.size !== true) {
    return new ImageGenerationError(400, 'unsupported_image_size', `${provider} does not support explicit image sizes`);
  }
  if (request.quality && request.quality !== 'auto' && capabilities.quality !== true) {
    return new ImageGenerationError(400, 'unsupported_image_quality', `${provider} does not support image quality controls`);
  }
  if (request.quality && request.quality !== 'auto' && typeof strategy.qualityOptionsForModel === 'function') {
    const options = strategy.qualityOptionsForModel(request.model);
    if (Array.isArray(options) && options.length > 0 && !options.includes(request.quality)) {
      return new ImageGenerationError(
        400,
        'unsupported_image_quality_value',
        `${provider} does not support image quality ${request.quality} for model ${request.model}`
      );
    }
  }
  if (request.background && capabilities.background !== true) {
    return new ImageGenerationError(400, 'unsupported_image_background', `${provider} does not support image background controls`);
  }
  if (request.outputFormat && capabilities.outputFormat !== true) {
    return new ImageGenerationError(400, 'unsupported_image_output_format', `${provider} does not support image output format controls`);
  }
  if (request.outputCompression != null && capabilities.outputCompression !== true) {
    return new ImageGenerationError(400, 'unsupported_image_output_compression', `${provider} does not support image output compression controls`);
  }
  if (request.moderation && capabilities.moderation !== true) {
    return new ImageGenerationError(400, 'unsupported_image_moderation', `${provider} does not support image moderation controls`);
  }
  return null;
}

function resolveEligibleImageAccounts(pool, registry, provider, request) {
  const entries = (Array.isArray(pool) ? pool : []).map((account) => {
    const strategy = registry.resolve(provider, account) || createUnsupportedImageGenerationStrategy(provider);
    const modelSupported = strategy.supportsModel(request.model);
    return {
      account,
      strategy,
      modelSupported,
      capabilityError: modelSupported ? resolveImageCapabilityError(strategy, request) : null
    };
  });
  return {
    entries,
    pool: entries
      .filter((entry) => entry.modelSupported && !entry.capabilityError)
      .map((entry) => entry.account)
  };
}

function resolveImageProvider(input) {
  const {
    request,
    options,
    state,
    headers,
    aliasTargetProvider,
    preferModelRouting,
    aliasResolution,
    deps = {}
  } = input;
  const resolveGatewayProvider = deps.resolveGatewayProvider || resolveGatewayProviderDefault;
  const gatewayResult = resolveGatewayProvider({
    options,
    state,
    requestJson: {
      model: request.model,
      ...(request.provider ? { provider: request.provider } : {})
    },
    headers,
    clientProtocol: 'openai_images',
    aliasTargetProvider,
    preferModelRouting,
    aliasResolution
  });
  const provider = String(gatewayResult && gatewayResult.provider || '').trim();
  if (provider) return provider;
  throw new ImageGenerationError(
    Number(gatewayResult && gatewayResult.statusCode) || 503,
    String(gatewayResult && gatewayResult.error || 'no_available_account'),
    String(gatewayResult && gatewayResult.detail || `no available account can serve model ${request.model}`)
  );
}

function resolveNoEligibleAccountError(eligible, provider, request) {
  const supportedModelEntries = eligible.entries.filter((entry) => entry.modelSupported);
  const capabilityEntry = supportedModelEntries.find((entry) => entry.capabilityError);
  if (capabilityEntry) return capabilityEntry.capabilityError;
  const hasProviderStrategy = eligible.entries.some((entry) => entry.strategy.kind !== 'unsupported');
  return new ImageGenerationError(
    400,
    hasProviderStrategy ? 'unsupported_model_for_images' : 'unsupported_image_provider',
    hasProviderStrategy
      ? `model ${request.model} is not supported for ${provider} image generation`
      : `provider ${provider} has no image generation support`
  );
}

async function executeImageGeneration(input) {
  const {
    request,
    provider,
    options = {},
    state,
    cooldownMs,
    requestMeta,
    routeKey,
    deps = {}
  } = input;
  const {
    chooseServerAccount,
    markProxyAccountFailure,
    appendProxyRequestLog
  } = deps;
  if (typeof chooseServerAccount !== 'function') {
    throw new ImageGenerationError(500, 'image_account_selector_unavailable', 'image account selector is not configured');
  }

  const pool = state && state.accounts && Array.isArray(state.accounts[provider]) ? state.accounts[provider] : [];
  if (pool.length === 0) {
    throw new ImageGenerationError(503, 'no_available_account', `no available ${provider} account`);
  }

  const registry = buildImageGenerationRegistry(deps);
  const eligible = resolveEligibleImageAccounts(pool, registry, provider, request);
  if (eligible.pool.length === 0) {
    throw resolveNoEligibleAccountError(eligible, provider, request);
  }

  const maxAttempts = resolveImageGenMaxAttempts(options);
  const attemptedRefs = new Set();
  const requestAccountFailures = createRequestAccountFailureRecorder((account, policy) => {
    applyAccountFailurePolicy(account, policy, {
      markProxyAccountFailure,
      defaultThreshold: options.failureThreshold,
      model: request.model
    });
  });
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const account = chooseServerAccount(eligible.pool, state, `image-gen:${provider}`, {
      provider,
      model: request.model,
      sessionKey: String(requestMeta && requestMeta.sessionKey || '').trim(),
      excludeAccountRefs: attemptedRefs
    });
    if (!account) break;
    attemptedRefs.add(String(account.accountRef || account.id || ''));

    const strategy = registry.resolve(provider, account) || createUnsupportedImageGenerationStrategy(provider);
    try {
      const resolveRequestOptions = typeof deps.resolveAccountEgressRequestOptions === 'function'
        ? deps.resolveAccountEgressRequestOptions
        : resolveAccountEgressRequestOptionsDefault;
      let accountRequestOptions;
      try {
        accountRequestOptions = await resolveRequestOptions({
          fs: deps.fs,
          aiHomeDir: deps.aiHomeDir || options.aiHomeDir,
          processObj: deps.processObj,
          provider,
          accountRef: account.accountRef,
          options,
          deps
        });
      } catch (error) {
        accountRequestOptions = {
          ok: false,
          error: 'account_egress_unavailable',
          egressError: String(error?.message || error || 'unknown')
        };
      }
      if (!accountRequestOptions?.ok || !accountRequestOptions.options) {
        throw new ImageGenerationError(
          503,
          'account_egress_unavailable',
          [
            String(accountRequestOptions?.error || 'account_egress_unavailable'),
            String(accountRequestOptions?.egressError || '')
          ].filter(Boolean).join(':')
        );
      }
      const attemptOptions = accountRequestOptions.options;
      const result = await strategy.generate({
        mode: request.mode,
        model: request.model,
        prompt: request.prompt,
        n: request.n,
        ...(request.size ? { size: request.size } : {}),
        ...(request.quality ? { quality: request.quality } : {}),
        responseFormat: request.responseFormat,
        ...(request.images ? { images: request.images } : {}),
        ...(request.background ? { background: request.background } : {}),
        ...(request.outputFormat ? { outputFormat: request.outputFormat } : {}),
        ...(request.outputCompression != null ? { outputCompression: request.outputCompression } : {}),
        ...(request.moderation ? { moderation: request.moderation } : {}),
        ...(request.mask ? { mask: request.mask } : {}),
        account,
        options: attemptOptions,
        state,
        requestMeta,
        requestJson: input.requestJson
      });
      const normalizedResult = normalizeImageGenerationResult(result);
      requestAccountFailures.recordSuccess(account);
      requestAccountFailures.finalize({ requestSucceeded: true });
      return { account, result: normalizedResult, strategy };
    } catch (error) {
      lastError = error;
      const policy = resolveImageFailurePolicy(error, {
        provider,
        cooldownMs,
        failureThreshold: options.failureThreshold
      });
      if (error && typeof error === 'object') {
        error.imageFailurePolicy = policy;
        error.imageProvider = provider;
      }
      observeSafely(() => {
        appendUpstreamFailureDiagnosticLog({
          options,
          appendProxyRequestLog,
          requestId: requestMeta && requestMeta.requestId,
          route: routeKey,
          provider,
          status: Number(error && error.statusCode) || 502,
          upstreamUrl: error && error.upstreamUrl,
          upstreamBody: error && error.upstreamBody,
          policy,
          account,
          attempt,
          maxAttempts,
          requestedModel: request.model,
          effectiveModel: request.model
        });
      });
      observeSafely(() => requestAccountFailures.record(account, policy));
      if (!policy.shouldRetryAnotherAccount) {
        requestAccountFailures.finalize({ requestSucceeded: false });
        throw error;
      }
    }
  }

  requestAccountFailures.finalize({ requestSucceeded: false });
  throw lastError || new ImageGenerationError(
    503,
    'no_available_account',
    `no healthy ${provider} account can serve model ${request.model}`
  );
}

async function runImageGeneration(input) {
  const request = input.request && typeof input.request === 'object'
    ? input.request
    : parseImageGenerationRequest(input.requestJson || {}, input.pathname);
  const provider = resolveImageProvider({
    ...input,
    request,
    headers: input.headers || input.req && input.req.headers
  });
  const execution = await executeImageGeneration({
    ...input,
    request,
    provider
  });
  return {
    request,
    provider,
    ...execution
  };
}

module.exports = {
  executeImageGeneration,
  runImageGeneration,
  __private: {
    ACCOUNT_FAILURE_CODES,
    buildImageGenerationRegistry,
    observeSafely,
    resolveImageFailurePolicy,
    resolveEligibleImageAccounts,
    resolveImageCapabilityError,
    resolveImageGenMaxAttempts,
    resolveImageProvider,
    resolveNoEligibleAccountError
  }
};
