'use strict';

const { ImageGenerationError } = require('./image-generation-strategy');
const { createImageGenerationStrategyRegistry } = require('./image-generation-strategy-registry');
const { createUnsupportedImageGenerationStrategy } = require('./image-generation-unsupported');
const { createPassthroughImageGenerationStrategy } = require('./image-generation-passthrough');
const { createLlmApiImageGenerationStrategy } = require('./image-generation-llm-api');
const { createAgyGeminiImageGenerationStrategy } = require('./image-generation-agy-gemini');
const { createCodexImageGenerationStrategy } = require('./image-generation-codex');
const { createGrokImageGenerationStrategy } = require('./image-generation-grok');
const {
  isImageRequestValidationError,
  parseImageGenerationRequest,
  parseImagePassthroughRequest
} = require('./image-generation-request');
const { normalizeImageGenerationResult } = require('./image-generation-output');
const { resolveGatewayProvider: resolveGatewayProviderDefault } = require('./capability-router');
const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { applyAccountFailurePolicy } = require('./account-runtime-state');
const { createRequestAccountFailureRecorder } = require('./request-account-failure-recorder');
const { buildModelAccountIndex, findRoutableAccountsForModel } = require('./model-account-index');
const { isDeprecatedGatewayProvider, listEnabledProviders } = require('./providers');
const { ACCOUNT_GUESSED_COOLDOWN_MS } = require('../cli/config/constants');
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

// 透传账号的上游根本没有图片端点（404 / 405 / 501）：说的是「这个账号的上游不提供生图」，
// 不是请求写错了。通用分类会把 404 当成「请求的资源不存在」直接甩给客户端，同池里真正
// 能生图的账号一次都轮不到 —— 这里字面构造：换号重试，只给 (账号, 模型) 记统一的短冷却。
const PASSTHROUGH_ENDPOINT_MISSING_STATUSES = new Set([404, 405, 501]);

function createImageEndpointUnavailablePolicy(statusCode, detail) {
  return {
    kind: 'image_endpoint_unavailable',
    retryable: true,
    shouldMarkFailure: true,
    shouldRetryAnotherAccount: true,
    shouldPassthroughToClient: true,
    failureThreshold: 1,
    cooldownMs: ACCOUNT_GUESSED_COOLDOWN_MS,
    clientStatusCode: statusCode,
    failureReason: 'image_endpoint_unavailable',
    detail,
    scope: 'model',
    shouldUnbindSession: false
  };
}

function resolveImageFailurePolicy(error, input = {}) {
  const code = String(error && error.code || 'upstream_failed').trim() || 'upstream_failed';
  const detail = String(error && (error.detail || error.message) || 'image generation failed').trim();
  const statusCode = code === 'invalid_access_token'
    ? 401
    : resolveWrappedUpstreamStatus(error);

  if (code === 'upstream_failed' && input.strategyKind === 'passthrough'
    && PASSTHROUGH_ENDPOINT_MISSING_STATUSES.has(statusCode)) {
    return createImageEndpointUnavailablePolicy(statusCode, detail);
  }

  if (code === 'upstream_failed' || code === 'invalid_access_token') {
    return classifyUpstreamFailure({
      account: input.account,
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
    passthrough: createPassthroughImageGenerationStrategy(deps),
    'llm-api': createLlmApiImageGenerationStrategy(deps)
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
  // auto / 默认格式等于「没指定」：客户端（如灵感工坊）会把默认值显式带上，
  // 不能因此把不支持该控制项的账号全部判为不合格。
  if (request.background && request.background !== 'auto' && capabilities.background !== true) {
    return new ImageGenerationError(400, 'unsupported_image_background', `${provider} does not support image background controls`);
  }
  if (request.outputFormat && capabilities.outputFormat !== true
    && request.outputFormat !== capabilities.defaultOutputFormat) {
    return new ImageGenerationError(400, 'unsupported_image_output_format', `${provider} does not support image output format controls`);
  }
  if (request.outputCompression != null && capabilities.outputCompression !== true) {
    return new ImageGenerationError(400, 'unsupported_image_output_compression', `${provider} does not support image output compression controls`);
  }
  if (request.moderation && request.moderation !== 'auto' && capabilities.moderation !== true) {
    return new ImageGenerationError(400, 'unsupported_image_moderation', `${provider} does not support image moderation controls`);
  }
  return null;
}

function resolveEligibleImageAccounts(pool, registry, provider, request) {
  // 宽松解析出来的请求（参数超出网关白名单，见 parseImagePassthroughRequest）只能交给
  // 透传上游裁决：原生策略按白名单翻译线协议，拿到它只会发出错误的请求。
  const passthroughOnly = Boolean(request && request.passthroughOnly);
  const entries = (Array.isArray(pool) ? pool : []).map((account) => {
    const strategy = registry.resolve(provider, account) || createUnsupportedImageGenerationStrategy(provider);
    const modelSupported = (!passthroughOnly || strategy.kind === 'passthrough')
      && strategy.supportsModel(request.model);
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

// 钉选账号（x-account-ref）只在 v1-router 判定「可用」后才进 requestMeta.accountRef；
// 钉选失效回落常池时这里拿不到值，不会把请求钉死在死账号上。
function readPinnedImageAccountRef(requestMeta) {
  return String(requestMeta && requestMeta.accountRef || '').trim();
}

function readAccountRef(account) {
  return String(account && account.accountRef || '').trim();
}

// provider 池按「钉选账号」与「回落证据账号」收窄；两者都没有时就是整池。
function selectImageAccountPool(state, provider, filters = {}) {
  const pool = state && state.accounts && Array.isArray(state.accounts[provider]) ? state.accounts[provider] : [];
  const pinnedAccountRef = String(filters.pinnedAccountRef || '').trim();
  const allowedRefs = Array.isArray(filters.accountRefs) ? new Set(filters.accountRefs) : null;
  if (!pinnedAccountRef && !allowedRefs) return pool;
  return pool.filter((account) => {
    const ref = readAccountRef(account);
    if (pinnedAccountRef && ref !== pinnedAccountRef) return false;
    return !allowedRefs || allowedRefs.has(ref);
  });
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

  const pinnedAccountRef = readPinnedImageAccountRef(requestMeta);
  const pool = selectImageAccountPool(state, provider, { pinnedAccountRef, accountRefs: input.accountRefs });
  if (pool.length === 0) {
    throw new ImageGenerationError(
      503,
      'no_available_account',
      pinnedAccountRef
        ? `pinned account ${pinnedAccountRef} is not available in the ${provider} pool`
        : `no available ${provider} account`
    );
  }

  const registry = buildImageGenerationRegistry(deps);
  const eligible = resolveEligibleImageAccounts(pool, registry, provider, request);
  if (eligible.pool.length === 0) {
    // 宽松请求没有任何透传账号能接：参数确实超出了原生能力，回给客户端的应是严格解析的原始错误。
    if (request.passthroughOnly && request.strictError) throw request.strictError;
    throw resolveNoEligibleAccountError(eligible, provider, request);
  }

  const maxAttempts = resolveImageGenMaxAttempts(options);
  const attemptedRefs = new Set();
  const requestAccountFailures = createRequestAccountFailureRecorder((account, policy) => {
    const gate = deps.accountRuntimeGate;
    if (gate && typeof gate.observeFailure === 'function') {
      gate.observeFailure({
        account,
        provider,
        policy,
        model: request.model,
        defaultThreshold: options.failureThreshold,
        source: 'server.upstream.failure'
      });
      return;
    }
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
      // 透传账号拿到客户端原始字段（HTTP 入口才有）：上游才是参数合法性的权威。
      const passthroughFields = strategy.kind === 'passthrough' && input.passthroughRequestJson
        ? {
          passthroughRequestJson: input.passthroughRequestJson,
          ...(request.passthroughJsonOnly ? { passthroughJsonOnly: true } : {})
        }
        : {};
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
        ...passthroughFields,
        account,
        options: attemptOptions,
        state,
        requestMeta,
        requestJson: input.requestJson
      });
      // 透传原体由入口原样渲染（上游是权威），只有网关自己翻译的结果才做严格规范化。
      const normalizedResult = result && result.passthroughBody
        ? result
        : normalizeImageGenerationResult(result);
      requestAccountFailures.recordSuccess(account);
      requestAccountFailures.finalize({ requestSucceeded: true });
      return { account, result: normalizedResult, strategy };
    } catch (error) {
      lastError = error;
      const policy = resolveImageFailurePolicy(error, {
        account,
        provider,
        strategyKind: strategy.kind,
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

// 严格解析失败时，只有 HTTP 入口（带 passthroughRequestJson）可以回落到透传口径：宽松请求
// 只交给透传账号，没有这类账号时执行器把严格解析的原始错误（strictError）抛回客户端。
function parseRouteImageRequest(input) {
  const requestJson = input.requestJson || {};
  try {
    return parseImageGenerationRequest(requestJson, input.pathname);
  } catch (error) {
    if (!input.passthroughRequestJson || !isImageRequestValidationError(error)) throw error;
    return { ...parseImagePassthroughRequest(requestJson, input.pathname), strictError: error };
  }
}

// 钉选账号决定 provider：只在它自己的池里选号，不按模型另找 provider。
function resolvePinnedImageProvider(state, accountRef) {
  if (!accountRef) return '';
  const accounts = state && state.accounts && typeof state.accounts === 'object' ? state.accounts : {};
  return Object.keys(accounts).find((provider) => (
    Array.isArray(accounts[provider]) && accounts[provider].some((account) => readAccountRef(account) === accountRef)
  )) || '';
}

// 调用方已经指定了归属（钉选账号、请求体 provider、x-provider 头、别名目标 provider）时
// 不跨 provider 回落：那是调用方的选择，回落等于替它改主意。
function hasExplicitImageRouting(input, request, headers) {
  if (readPinnedImageAccountRef(input.requestMeta)) return true;
  if (request && request.provider) return true;
  if (String(input.aliasTargetProvider || '').trim()) return true;
  const headerProvider = headers && (headers['x-provider'] || headers['X-Provider']);
  return Boolean(String(headerProvider || '').trim());
}

const IMAGE_PROVIDER_FALLBACK_CODES = new Set([
  'no_available_account',
  'no_account_supports_model',
  'unsupported_model_for_images',
  'unsupported_image_provider'
]);

// 失败说的是「这个 provider 此刻服务不了」（池空 / 没有合格账号 / 能力不够 / 可换号的失败
// 已经换遍），而不是请求本身有问题时，才值得换 provider 再试。
function isImageProviderFallbackError(error, request) {
  if (!error) return false;
  if (request && request.strictError && error === request.strictError) return true;
  const policy = error.imageFailurePolicy;
  if (policy) return policy.shouldRetryAnotherAccount === true;
  const code = String(error.code || '').trim();
  return IMAGE_PROVIDER_FALLBACK_CODES.has(code) || code.startsWith('unsupported_image_');
}

function resolveModelAccountIndex(state, options) {
  const index = state && state.modelAccountIndex;
  return index && index.builtAt > 0 ? index : buildModelAccountIndex(state || {}, options || {});
}

// 回落候选：模型目录（含 OAuth 账号合成的原生图像规格）**正面**说「这个 provider 的这些账号
// 能出这个模型」的 provider，且只用这些账号 —— 透传账号的 supportsModel 恒为 true，不收窄
// 就会把生图请求发给一个只会聊天的中转。排序：废弃 provider 最后，证据账号多的优先，其余按
// provider 表顺序。
function listImageFallbackCandidates(input, model, attemptedProviders) {
  const options = input.options || {};
  const index = resolveModelAccountIndex(input.state, options);
  return listEnabledProviders(options.provider)
    .filter((provider) => !attemptedProviders.has(provider))
    .map((provider, order) => ({ provider, order, accountRefs: findRoutableAccountsForModel(index, model, provider) }))
    .filter((candidate) => candidate.accountRefs.length > 0)
    .sort((left, right) => (
      Number(isDeprecatedGatewayProvider(left.provider)) - Number(isDeprecatedGatewayProvider(right.provider))
      || right.accountRefs.length - left.accountRefs.length
      || left.order - right.order
    ));
}

// 主 provider 服务不了时按正面证据依次换 provider（责任链）。全部失败时：有账号真实尝试过就报
// 最后一次尝试的错误（与同 provider 内换号的口径一致），否则报主 provider 的原始错误。
async function runImageProviderFallback(input, request, attemptedProviders, primaryError) {
  let lastAttemptError = null;
  for (const candidate of listImageFallbackCandidates(input, request.model, attemptedProviders)) {
    attemptedProviders.add(candidate.provider);
    try {
      const execution = await executeImageGeneration({
        ...input,
        request,
        provider: candidate.provider,
        accountRefs: candidate.accountRefs
      });
      return { request, provider: candidate.provider, ...execution };
    } catch (error) {
      if (!isImageProviderFallbackError(error, request)) throw error;
      if (error.imageFailurePolicy) lastAttemptError = error;
    }
  }
  throw lastAttemptError || primaryError;
}

async function runImageGeneration(input) {
  const request = input.request && typeof input.request === 'object'
    ? input.request
    : parseRouteImageRequest(input);
  const headers = input.headers || input.req && input.req.headers;
  const fallbackAllowed = !hasExplicitImageRouting(input, request, headers);
  const attemptedProviders = new Set();
  let primaryError = null;
  let provider = resolvePinnedImageProvider(input.state, readPinnedImageAccountRef(input.requestMeta));
  if (!provider) {
    try {
      provider = resolveImageProvider({ ...input, request, headers });
    } catch (error) {
      if (!fallbackAllowed || !isImageProviderFallbackError(error, request)) throw error;
      primaryError = error;
    }
  }
  if (provider) {
    attemptedProviders.add(provider);
    try {
      const execution = await executeImageGeneration({ ...input, request, provider });
      return { request, provider, ...execution };
    } catch (error) {
      if (!fallbackAllowed || !isImageProviderFallbackError(error, request)) throw error;
      primaryError = error;
    }
  }
  return runImageProviderFallback(input, request, attemptedProviders, primaryError);
}

module.exports = {
  executeImageGeneration,
  runImageGeneration,
  __private: {
    ACCOUNT_FAILURE_CODES,
    buildImageGenerationRegistry,
    createImageEndpointUnavailablePolicy,
    hasExplicitImageRouting,
    isImageProviderFallbackError,
    listImageFallbackCandidates,
    observeSafely,
    parseRouteImageRequest,
    resolveImageFailurePolicy,
    resolveEligibleImageAccounts,
    resolveImageCapabilityError,
    resolveImageGenMaxAttempts,
    resolveImageProvider,
    resolveNoEligibleAccountError,
    resolvePinnedImageProvider,
    selectImageAccountPool
  }
};
