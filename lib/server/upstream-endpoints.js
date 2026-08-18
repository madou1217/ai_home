'use strict';

const { resolveRequestProvider, normalizeExplicitProvider } = require('./router');
const { isLoopbackUrl } = require('./http-utils');
const { __private: httpUtilsPrivate } = require('./http-utils');
const { isApiCredentialAccount } = require('../account/runtime-auth-mode');
const { resolveProviderApiBaseUrl } = require('../account/provider-api-base-url');
const {
  applyClaudeCodeIdentityHeaders,
  ensureClaudeCodeSystemBuffer
} = require('./claude-official-client');
const { classifyUpstreamFailure, describeError } = require('./upstream-failure-policy');
const {
  isZcodeCaptchaRequiredErrorBody,
  DEFAULT_VERIFY_TIMEOUT_MS: ZCODE_CAPTCHA_VERIFY_TIMEOUT_MS
} = require('./zcode-captcha-bridge');
const { applyZcodeDesktopIdentity, isNativeZcodeOAuthAccount } = require('./zcode-official-client');
const { applyAccountFailurePolicy } = require('./account-runtime-state');
const { runWithAccountAttempts } = require('./request-orchestrator');
const {
  buildNoAvailableAccountResponse,
  hasUnavailableReason
} = require('./account-availability');
const {
  createUpstreamFailureRecorder,
  writeUnavailableAccountResponse,
  writeUpstreamFailureReplay
} = require('./upstream-failure-replay');
const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const { resolveOpenAIChatFinishReason } = require('./protocol-finish-reason');
const { guardNonVisionImagePayload } = require('./vision-image-guard');
const {
  isImageGenerationModel,
  extractInlineImageMarkdown
} = require('./code-assist-image-generation');
const { createCanonicalRenderer } = require('./protocol-stream-pipeline');
const { anthropicMessageToCanonicalEvents } = require('./code-assist-anthropic-adapter');
const {
  PROVIDER_PROTOCOL_TRANSPORTS,
  resolveProviderProtocolRoutePlan,
  resolveProviderProtocolTransport
} = require('./provider-protocol-routing');
const {
  compactProviderProtocolPlan,
  createProviderProtocolPlan
} = require('./provider-protocol-plan');
const {
  discoverProviderModels,
  buildModelDiscoverySignature
} = require('./provider-model-discovery');
const { selectPoolAccountsForModel } = require('./model-account-pool-selector');
const {
  getWebUiModelsCache
} = require('./webui-model-cache');
const {
  applyModelCatalogSettingsToEntries
} = require('./model-catalog-settings-store');
const {
  refreshStaleAgyUsageSnapshotsForPool,
  scheduleAgyUsageRefreshAfterFailure
} = require('./agy-usage-snapshot');
const {
  createRequestAccountFailureRecorder
} = require('./request-account-failure-recorder');
const {
  DEFAULT_REQUEST_BUDGET_MS,
  DEFAULT_RETRY_DELAY_MS,
  MIN_RETRY_ATTEMPT_BUDGET_MS,
  decideTransientPoolRetry
} = require('./request-pool-retry-policy');
const {
  fetchOpenCodeChatCompletion,
  fetchOpenCodeChatCompletionStream
} = require('./opencode-server-client');
const {
  writeOpenAIChatCompletionPayloadAsSse
} = require('./openai-chat-sse');
const { decodeResponseBuffer } = require('./response-body');
const { unwrapUpstreamEnvelopeBody } = require('./openai-response-envelope');
const { applyAccountUpstreamHeaders } = require('./upstream-account-profile');
const { buildKimiRequestHeaders } = require('./kimi-request-headers');
const {
  createBoundedTailCapture,
  createDownstreamAbortContext,
  pipeReadableBodyToResponse
} = require('./upstream-stream-forwarder');
const {
  isUnrecoverableTokenRefreshFailure,
  normalizeTokenRefreshFailureReason
} = require('./token-refresh-result');

const { HOP_BY_HOP_HEADERS, STREAM_RESPONSE_OPEN_TIMEOUT_MS, isCodeAssistProvider, ANTHROPIC_STREAM_KEEPALIVE_IDLE_MS, ANTHROPIC_STREAM_KEEPALIVE_TICK_MS } = require('./upstream-endpoints-utils');
const { buildProviderByAccountRef, buildModelListEntries } = require('./upstream-endpoints-models');
const { resolveProviderUpstream, baseUrlEndsWithPath, resolveProviderPath, isAnthropicCompatibleBaseUrl, stripUrlQueryAndHash, isClaudeMessagesPath, isOpenAIChatCompletionsPath, isGeminiGenerateContentPath, isGeminiStreamGenerateContentPath } = require('./upstream-endpoints-path');
const { shouldSkipForwardHeader, normalizeHeaderValue, isSafeHeaderValue, sanitizeAccessToken, sendRawUpstreamResponse, writeGeneralUpstreamResponseHeaders, writeUpstreamSseHeaders } = require('./upstream-endpoints-headers');
const { writeCodeAssistAnthropicSseHeaders, writeCanonicalEventsAsAnthropicSse, writeCanonicalEventStreamAsAnthropicSse, isNonEmptyCanonicalAssistantEvent, createEmptyUpstreamResponseError, closeAsyncIterator, replayPrimedAsyncIterator, isNonEmptyGeminiGenerateContentPiece, requireNonEmptyGeminiGenerateContentStream, requireNonEmptyCanonicalEventStream, tapCanonicalEventStream } = require('./upstream-endpoints-sse');
const { firstObject, parseJsonPayloads, parseSseJsonPayloads, getPayloadModel, extractModelUsageInputFromPayload, extractModelUsageInputFromRaw, recordSuccessfulModelUsage, createModelUsageCapture } = require('./upstream-endpoints-usage');
const { describeUpstreamError, isGlobalNetworkFailure, withNetworkHint, mapGeminiFinishReason, selectAccountsForRequestModel, writeNoModelAccountResponse, shouldDeferAliasRuntimeFailure, createAliasRuntimeFailureResult, applyFailurePolicyToAccount, createTokenRefreshUnavailablePolicy } = require('./upstream-endpoints-failure');
const { shouldUseCodeAssistAnthropicDirectTransport, shouldUseOpenCodeGoApiTransport } = require('./upstream-endpoints-transport');
const { createUpstreamAttemptHandler } = require('./upstream-endpoints-attempt');
async function handleUpstreamModels(ctx) {
  const {
    options,
    state,
    res,
    deps
  } = ctx;

  const {
    buildOpenAIModelsList,
    fetchModelsForAccount,
    FALLBACK_MODELS,
    modelCatalogSettings
  } = deps;

  const ttl = Math.max(1000, Number(options.modelsCacheTtlMs) || 300000);
  const candidateLimit = Math.max(1, Number(options.modelsProbeAccounts) || 2);
  const providerMode = options && options.provider || 'auto';
  const signature = `${buildModelDiscoverySignature(state, {
    providerMode,
    includeCodex: false
  })}|limit=${candidateLimit}`;
  const probeTimeout = Math.min(4000, Number(options.upstreamTimeoutMs) || 8000);

  const sendCachedPayload = (cacheState) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    const ids = Array.isArray(cacheState.ids) ? cacheState.ids : [];
    if (ids.length === 0 && cacheState.firstError) {
      res.setHeader('x-aih-models-fallback', '1');
    }
    res.end(JSON.stringify(buildOpenAIModelsList(buildModelListEntries(
      ids,
      modelCatalogSettings || state.modelCatalogSettings,
      options,
      FALLBACK_MODELS,
      cacheState.byAccount,
      state
    ))));
  };

  // Probe every candidate account upstream and refresh the shared cache. Slow
  // (real HTTP to each provider); callers decide whether to await it.
  const runDiscoveryAndCache = async () => {
    const discovery = await discoverProviderModels({
      state,
      options,
      fetchModelsForAccount,
      providerMode,
      includeCodex: false,
      accountLimit: candidateLimit,
      timeoutMs: probeTimeout
    });
    state.modelsCache = {
      updatedAt: Date.now(),
      ids: discovery.ids,
      byProvider: discovery.byProvider,
      byAccount: discovery.byAccount,
      sourceCount: discovery.sourceCount,
      scannedAccounts: discovery.scannedAccounts,
      firstError: discovery.firstError,
      source: discovery.source,
      signature
    };
    return state.modelsCache;
  };

  // Fire a background refresh at most once at a time (de-duped by signature),
  // so stale responses stay instant while the cache catches up.
  const scheduleBackgroundRefresh = () => {
    if (state.modelsCacheRefreshing === signature) return;
    state.modelsCacheRefreshing = signature;
    Promise.resolve()
      .then(runDiscoveryAndCache)
      .catch(() => {})
      .finally(() => {
        if (state.modelsCacheRefreshing === signature) {
          state.modelsCacheRefreshing = null;
        }
      });
  };

  const now = Date.now();
  const cache = state.modelsCache || {};
  const hasUsableCache = cache.updatedAt > 0 && Array.isArray(cache.ids);
  const isFresh = hasUsableCache
    && now - cache.updatedAt < ttl
    && cache.signature === signature;

  // Fresh: serve instantly.
  if (isFresh) {
    res.setHeader('x-aih-models-cache', 'hit');
    sendCachedPayload(cache);
    return;
  }

  // Stale (expired or signature changed) but usable: serve the old list now and
  // refresh in the background — the next request gets the updated set. This is
  // what keeps /v1/models well under 300ms in steady state.
  if (hasUsableCache && cache.ids.length > 0) {
    res.setHeader('x-aih-models-cache', 'stale');
    sendCachedPayload(cache);
    scheduleBackgroundRefresh();
    return;
  }

  // Cold start: nothing cached yet, must probe synchronously this once.
  res.setHeader('x-aih-models-cache', 'miss');
  await runDiscoveryAndCache();
  sendCachedPayload(state.modelsCache);
}

async function handleUpstreamPassthrough(ctx) {
  const {
    options,
    state,
    req,
    res,
    method,
    bodyBuffer,
    requestJson,
    routeKey,
  } = ctx;
  const {
    requestStartedAt,
    cooldownMs,
    requestMeta,
    deps
  } = ctx;

  const {
    chooseServerAccount,
    pushMetricError,
    writeJson,
    fetchWithTimeout,
    fetchGeminiCodeAssistChatCompletion,
    fetchGeminiCodeAssistChatCompletionStream,
    fetchGeminiCodeAssistGenerateContent,
    fetchGeminiCodeAssistGenerateContentStream,
    fetchModelsForAccount,
    fetchCodeAssistAnthropicMessage,
    fetchCodeAssistAnthropicMessageStream,
    fetchOpenCodeChatCompletion: fetchOpenCodeChatCompletionDep,
    fetchOpenCodeChatCompletionStream: fetchOpenCodeChatCompletionStreamDep,
    markProxyAccountFailure,
    markProxyAccountSuccess,
    recordModelUsage,
    appendProxyRequestLog,
    refreshCodexAccessToken,
    refreshClaudeAccessToken,
    refreshAgyAccessToken,
    refreshGrokAccessToken,
    refreshKimiAccessToken
  } = deps;

  const requestedAccountRef = String(
    req
    && req.headers
    && (req.headers['x-account-ref'] || req.headers['X-Account-Ref'])
    || ''
  ).trim();
  const effectiveProvider = normalizeExplicitProvider(requestMeta && requestMeta.effectiveProvider);
  const provider = effectiveProvider || (typeof deps.resolveRequestProvider === 'function'
    ? deps.resolveRequestProvider(options, requestJson || {}, req && req.headers, state)
    : resolveRequestProvider(options, requestJson || {}, req && req.headers, state));
  const refreshProviderAccessToken = ({
    codex: refreshCodexAccessToken,
    claude: refreshClaudeAccessToken,
    agy: refreshAgyAccessToken,
    grok: refreshGrokAccessToken,
    kimi: refreshKimiAccessToken
  })[provider] || null;
  if (!state.metrics.providerCounts || typeof state.metrics.providerCounts !== 'object') state.metrics.providerCounts = {};
  if (!state.metrics.providerSuccess || typeof state.metrics.providerSuccess !== 'object') state.metrics.providerSuccess = {};
  if (!state.metrics.providerFailures || typeof state.metrics.providerFailures !== 'object') state.metrics.providerFailures = {};
  state.metrics.providerCounts[provider] = Number(state.metrics.providerCounts[provider] || 0) + 1;
  const streamRequested = Boolean(
    requestJson && requestJson.stream
    || isGeminiStreamGenerateContentPath(req && req.url || '')
  );
  const attemptMutable = {
    streamTransport: streamRequested ? 'unknown' : 'non_stream',
    lastError: '',
    finalStatusCode: 502,
    transientPoolRetryUsed: false,
    transientPoolRetryDeadlineAt: 0
  };

  // Non-vision target + image payload would 400 upstream before any turn exists,
  // so the model could never borrow vision in-band. Strip images to blob handles
  // here. Adapter dispatch paths consume requestJson directly; general
  // passthrough uses guardedBodyBuffer so it cannot fall back to the original
  // bytes after this mutation. Vision-capable targets keep the exact raw body.
  const visionGuard = guardNonVisionImagePayload(requestJson, { provider });
  const guardedBodyBuffer = visionGuard.changed
    ? Buffer.from(JSON.stringify(requestJson))
    : bodyBuffer;
  if (visionGuard.changed) {
    console.log(`[aih] vision-guard: stripped ${visionGuard.count} image(s) for non-vision model ${visionGuard.model} (request ${requestMeta && requestMeta.requestId})`);
  }

  const requestedModel = String(requestJson && requestJson.model || '').trim();
  let requestSucceeded = false;
  const recordAccountSuccess = (account, model = requestedModel) => {
    markProxyAccountSuccess(account, { model });
    requestAccountFailures.recordSuccess(account);
    requestSucceeded = true;
    state.metrics.totalSuccess += 1;
    state.metrics.providerSuccess[provider] = Number(state.metrics.providerSuccess[provider] || 0) + 1;
  };
  const requestAccountFailures = createRequestAccountFailureRecorder((account, policy) => {
    applyFailurePolicyToAccount(
      account,
      policy,
      markProxyAccountFailure,
      options.failureThreshold,
      requestedModel
    );
  });
  // Keep call sites focused on policy classification. This request-local
  // adapter decides whether account state can be updated immediately or must
  // wait for sibling-account evidence.
  const recordAccountFailure = (account, policy) => {
    requestAccountFailures.record(account, policy);
  };
  // 换账号重试会丢掉上一个账号的真实上游响应；先留档，池子耗尽时用它回话。
  const upstreamFailureRecorder = createUpstreamFailureRecorder();
  const providerProtocolRoute = resolveProviderProtocolRoutePlan(requestMeta);
  const providerProtocolPlan = requestMeta && requestMeta.providerProtocolPlan
    ? requestMeta.providerProtocolPlan
    : compactProviderProtocolPlan(createProviderProtocolPlan({
      route: providerProtocolRoute,
      provider,
      sourceClientProtocol: requestMeta && requestMeta.sourceClientProtocol,
      clientProtocol: requestMeta && requestMeta.clientProtocol
    }));
  const codeAssistProvider = isCodeAssistProvider(provider);
  const codeAssistSessionMapKey = `${provider}SessionIdMap`;
  if (codeAssistProvider && !(state[codeAssistSessionMapKey] instanceof Map)) {
    state[codeAssistSessionMapKey] = new Map();
  }
  const geminiRequestOptions = codeAssistProvider
    ? {
        ...options,
        provider,
        responseModel: String(
          requestMeta
          && requestMeta.aliasResolution
          && requestMeta.aliasResolution.requestedModel
          || requestJson
          && requestJson.model
          || ''
        ).trim(),
        sessionKey: String(requestMeta && requestMeta.sessionKey || '').trim(),
        geminiSessionIdMap: state[codeAssistSessionMapKey],
        geminiSessionIdMapTtlMs: state.sessionAffinity && state.sessionAffinity.ttlMs,
        geminiSessionIdMapMaxEntries: state.sessionAffinity && state.sessionAffinity.maxEntries,
        toolProtocolDiagnostics: true,
        sourceClientProtocol: String(
          requestMeta && requestMeta.sourceClientProtocol
          || providerProtocolPlan && providerProtocolPlan.sourceClientProtocol
          || ''
        ).trim(),
        clientProtocol: String(
          requestMeta && requestMeta.clientProtocol
          || providerProtocolPlan && providerProtocolPlan.clientProtocol
          || ''
        ).trim(),
        protocolAdapterPath: Array.isArray(requestMeta && requestMeta.protocolAdapterPath)
          ? requestMeta.protocolAdapterPath.filter(Boolean)
          : (providerProtocolPlan && Array.isArray(providerProtocolPlan.requestAdapterPath)
            ? providerProtocolPlan.requestAdapterPath.slice()
            : []),
        ...(providerProtocolPlan ? { providerProtocolPlan } : {}),
        ...(providerProtocolRoute ? { providerProtocolRoute } : {})
      }
    : options;
  const providerPoolRaw = Array.isArray(state.accounts && state.accounts[provider]) ? state.accounts[provider] : [];
  const providerPool = providerPoolRaw;
  const selectedPool = requestedAccountRef
    ? providerPool.filter((account) => String(account && account.accountRef || '') === requestedAccountRef)
    : providerPool;
  if (
    selectedPool.length > 0
    && String(requestJson && requestJson.model || '').trim()
    && typeof fetchModelsForAccount === 'function'
  ) {
    await getWebUiModelsCache(state, options, {
      fetchModelsForAccount
    }).catch(() => null);
  }
  if (provider === 'agy' && selectedPool.length > 0 && String(requestJson && requestJson.model || '').trim()) {
    await refreshStaleAgyUsageSnapshotsForPool({
      pool: selectedPool,
      options,
      fs: deps.fs,
      aiHomeDir: deps.aiHomeDir || options.aiHomeDir,
      fetchWithTimeout
    }).catch(() => null);
  }
  const modelPoolSelection = selectAccountsForRequestModel(
    selectedPool,
    provider,
    requestJson || {},
    state,
    options
  );
  const pool = modelPoolSelection.pool;
  if (modelPoolSelection.filtered && selectedPool.length > 0 && pool.length < 1) {
    if (shouldDeferAliasRuntimeFailure(requestMeta, res)) {
      return createAliasRuntimeFailureResult({
        requestMeta,
        provider,
        model: modelPoolSelection.model,
        statusCode: 503,
        error: 'no_available_account',
        detail: `no available ${provider} account can serve model ${modelPoolSelection.model}`,
        attemptedAccountRefs: []
      });
    }
    writeNoModelAccountResponse({
      writeJson,
      res,
      provider,
      routeKey,
      state,
      pushMetricError,
      requestMeta,
      requestStartedAt,
      streamRequested,
      streamTransport: attemptMutable.streamTransport,
      selectedPool,
      model: modelPoolSelection.model,
      requestedAccountRef,
      appendProxyRequestLog,
      options
    });
    return;
  }
  const configuredMaxAttempts = Math.max(1, Number(options.maxAttempts) || 3);
  const poolSize = Math.max(1, pool.length);
  const shouldCoverCodeAssistPool = codeAssistProvider && !requestedAccountRef && pool.length > 0;
  const retryMaxAttempts = shouldCoverCodeAssistPool
    ? Math.max(configuredMaxAttempts, poolSize)
    : configuredMaxAttempts;
  const baseMaxAttempts = Math.min(retryMaxAttempts, poolSize);
  const authRetryBudget = (
    typeof refreshProviderAccessToken === 'function'
    && pool.length > 0
  ) ? 1 : 0;
  const maxAttempts = baseMaxAttempts + authRetryBudget;
  const transientPoolRetryEnabled = codeAssistProvider && !requestedAccountRef && pool.length > 1;
  const transientPoolRetryMaxAttempts = transientPoolRetryEnabled ? pool.length : 0;
  const diagnosticMaxAttempts = () => maxAttempts + (
    attemptMutable.transientPoolRetryUsed ? transientPoolRetryMaxAttempts : 0
  );
  const waitForPoolRetry = typeof deps.waitForPoolRetry === 'function'
    ? deps.waitForPoolRetry
    : (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
  const poolRetryDelayMs = Math.max(0, Number(options.transientPoolRetryDelayMs) || DEFAULT_RETRY_DELAY_MS);
  const requestBudgetMs = Math.max(
    1000,
    Math.min(Number(options.upstreamTimeoutMs) || DEFAULT_REQUEST_BUDGET_MS, DEFAULT_REQUEST_BUDGET_MS)
  );
  const forcedRefreshRetryUsed = new Set();
  const refreshCodeAssistAfterAuthFailure = async (error, account) => {
    if (String(error && error.code || '').trim().toUpperCase() !== 'HTTP_401') return null;
    if (res.headersSent || res.writableEnded) return null;
    if (typeof refreshProviderAccessToken !== 'function' || isApiCredentialAccount(account)) return null;
    const accountRef = String(account && account.accountRef || '').trim();
    if (!accountRef || forcedRefreshRetryUsed.has(accountRef)) return null;

    let refreshResult = null;
    try {
      refreshResult = await refreshProviderAccessToken(account, {
        force: true,
        timeoutMs: options.upstreamTimeoutMs,
        proxyUrl: options.proxyUrl,
        noProxy: options.noProxy
      }, {
        fetchWithTimeout
      });
    } catch (_error) {
      refreshResult = {
        ok: false,
        refreshed: false,
        reason: 'refresh_exception'
      };
    }
    const retrySameAccount = Boolean(refreshResult && refreshResult.ok && refreshResult.refreshed);
    if (retrySameAccount) forcedRefreshRetryUsed.add(accountRef);
    return { refreshResult, retrySameAccount };
  };
  const orchestration = await runWithAccountAttempts({
    pool,
    maxAttempts,
    chooseServerAccount,
    selectionState: state,
    cursorState: state.cursors,
    cursorKey: provider,
    provider,
    model: String(requestJson && requestJson.model || '').trim(),
    strategy: state.strategy,
    sessionKey: (requestMeta && requestMeta.sessionKey) || '',
    // Last-resort: when the alias preflight found every candidate only soft
    // (model) cooled, serve through a model-cooled account instead of 503'ing.
    allowModelCooled: Boolean(requestMeta && requestMeta.allowModelCooled),
    retryRoundMaxAttempts: transientPoolRetryMaxAttempts,
    prepareRetryRound: transientPoolRetryEnabled
      ? async ({ attemptedAccountRefs }) => {
          const failureSnapshot = requestAccountFailures.snapshot();
          const decision = decideTransientPoolRetry({
            provider,
            codeAssistProvider,
            pinnedAccount: Boolean(requestedAccountRef),
            retryUsed: attemptMutable.transientPoolRetryUsed,
            responseStarted: Boolean(res.headersSent || res.writableEnded),
            attemptedAccountRefs,
            pendingAccountRefs: failureSnapshot.pendingAccountRefs,
            immediateFailureRecorded: failureSnapshot.immediateFailureRecorded,
            delayMs: poolRetryDelayMs,
            elapsedMs: Date.now() - requestStartedAt,
            requestBudgetMs,
            hasRouteFallback: Boolean(
              requestMeta
              && requestMeta.aliasRuntimeFallback
              && requestMeta.aliasRuntimeFallback.enabled
            )
          });
          if (!decision.retry) return decision;
          attemptMutable.transientPoolRetryUsed = true;
          attemptMutable.transientPoolRetryDeadlineAt = requestStartedAt + decision.retryDeadlineElapsedMs;
          if (options.logRequests) {
            appendProxyRequestLog({
              at: new Date().toISOString(),
              kind: 'transient_pool_retry',
              requestId: requestMeta && requestMeta.requestId,
              route: routeKey,
              provider,
              model: requestedModel,
              attemptedAccountRefs: Array.from(attemptedAccountRefs || []),
              delayMs: decision.delayMs,
              durationMs: Date.now() - requestStartedAt
            });
          }
          await waitForPoolRetry(decision.delayMs);
          return decision;
        }
      : null,
    onAttempt: createUpstreamAttemptHandler({
      options,
      state,
      req,
      res,
      method,
      bodyBuffer,
      requestJson,
      routeKey,
      requestStartedAt,
      cooldownMs,
      requestMeta,
      deps,
      provider,
      refreshProviderAccessToken,
      streamRequested,
      guardedBodyBuffer,
      requestedModel,
      requestedAccountRef,
      recordAccountSuccess,
      recordAccountFailure,
      upstreamFailureRecorder,
      refreshCodeAssistAfterAuthFailure,
      codeAssistProvider,
      geminiRequestOptions,
      modelPoolSelection,
      shouldCoverCodeAssistPool,
      diagnosticMaxAttempts,
      requestBudgetMs,
      fetchWithTimeout,
      pushMetricError,
      writeJson,
      fetchGeminiCodeAssistChatCompletion,
      fetchGeminiCodeAssistChatCompletionStream,
      fetchGeminiCodeAssistGenerateContent,
      fetchGeminiCodeAssistGenerateContentStream,
      fetchCodeAssistAnthropicMessage,
      fetchCodeAssistAnthropicMessageStream,
      fetchOpenCodeChatCompletionDep,
      fetchOpenCodeChatCompletionStreamDep,
      markProxyAccountFailure,
      recordModelUsage,
      appendProxyRequestLog,
      forcedRefreshRetryUsed,
      attemptMutable
    }),
  });

  const requestFailureResolution = requestAccountFailures.finalize({
    requestSucceeded
  });
  if (requestFailureResolution.discarded > 0) {
    console.warn(
      `[aih] treated ambiguous ${provider} ${requestedModel || 'unknown-model'} failures as request-scoped `
      + `(request ${requestMeta && requestMeta.requestId || 'unknown'}, accounts: ${requestFailureResolution.discardedAccountRefs.join(',')})`
    );
  }
  if (orchestration.kind === 'returned') return;
  if (orchestration.kind === 'no_account') {
    // 池子耗尽 ≠ 没打过上游。本次请求若已经拿到过真实的上游失败，那才是要回给客户端的答案。
    const upstreamFailureReplay = upstreamFailureRecorder.get();
    if (shouldDeferAliasRuntimeFailure(requestMeta, res)) {
      return createAliasRuntimeFailureResult({
        requestMeta,
        provider,
        model: String(requestJson && requestJson.model || '').trim(),
        statusCode: upstreamFailureReplay ? upstreamFailureReplay.statusCode : 503,
        error: upstreamFailureReplay ? upstreamFailureReplay.error : 'no_available_account',
        detail: upstreamFailureReplay ? upstreamFailureReplay.detail : 'no_available_account',
        attemptedAccountRefs: Array.from(orchestration.attemptedAccountRefs || [])
      });
    }
    state.metrics.totalFailures += 1;
    if (upstreamFailureReplay) {
      state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
      pushMetricError(state.metrics, routeKey, provider, {
        message: upstreamFailureReplay.detail,
        error: upstreamFailureReplay.error,
        attemptedAccountRefs: Array.from(orchestration.attemptedAccountRefs || []),
        model: (requestJson && requestJson.model) || (requestMeta && requestMeta.model) || '',
        sessionId: requestMeta && (requestMeta.sessionId || requestMeta.sessionKey),
        projectPath: requestMeta && requestMeta.projectPath,
        projectDirName: requestMeta && requestMeta.projectDirName
      });
      if (options.logRequests) {
        appendProxyRequestLog({
          at: new Date().toISOString(),
          requestId: requestMeta && requestMeta.requestId,
          route: routeKey,
          provider,
          status: upstreamFailureReplay.statusCode,
          error: upstreamFailureReplay.detail,
          streamRequested,
          streamTransport: attemptMutable.streamTransport,
          durationMs: Date.now() - requestStartedAt
        });
      }
      writeUpstreamFailureReplay(res, upstreamFailureReplay, {
        sendRawUpstreamResponse,
        writeJson
      });
      return;
    }
    pushMetricError(state.metrics, routeKey, provider, {
      message: 'no_available_account',
      error: 'no_available_account',
      model: (requestJson && requestJson.model) || (requestMeta && requestMeta.model) || '',
      sessionId: requestMeta && (requestMeta.sessionId || requestMeta.sessionKey),
      projectPath: requestMeta && requestMeta.projectPath,
      projectDirName: requestMeta && requestMeta.projectDirName
    });
    const unavailable = buildNoAvailableAccountResponse(provider, selectedPool, {
      model: String(requestJson && requestJson.model || '').trim()
    });
    writeUnavailableAccountResponse(res, writeJson, unavailable);
    return;
  }
  if (
    orchestration.kind === 'attempts_exhausted'
    && hasUnavailableReason(pool, 'auth_invalid_reauth_required')
  ) {
    const unavailable = buildNoAvailableAccountResponse(provider, selectedPool, {
      model: String(requestJson && requestJson.model || '').trim()
    });
    if (shouldDeferAliasRuntimeFailure(requestMeta, res)) {
      return createAliasRuntimeFailureResult({
        requestMeta,
        provider,
        model: String(requestJson && requestJson.model || '').trim(),
        statusCode: unavailable.statusCode,
        error: unavailable.payload.error,
        detail: unavailable.payload.detail,
        attemptedAccountRefs: Array.from(orchestration.attemptedAccountRefs || [])
      });
    }
    state.metrics.totalFailures += 1;
    state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
    pushMetricError(state.metrics, routeKey, provider, {
      message: 'no_available_account',
      error: 'no_available_account',
      model: (requestJson && requestJson.model) || (requestMeta && requestMeta.model) || '',
      sessionId: requestMeta && (requestMeta.sessionId || requestMeta.sessionKey),
      projectPath: requestMeta && requestMeta.projectPath,
      projectDirName: requestMeta && requestMeta.projectDirName
    });
    if (options.logRequests) {
      appendProxyRequestLog({
        at: new Date().toISOString(),
        requestId: requestMeta && requestMeta.requestId,
        route: routeKey,
        provider,
        status: unavailable.statusCode,
        error: attemptMutable.lastError || 'no_available_account',
        streamRequested,
        streamTransport: attemptMutable.streamTransport,
        durationMs: Date.now() - requestStartedAt
      });
    }
    writeUnavailableAccountResponse(res, writeJson, unavailable);
    return;
  }

  if (
    (orchestration.kind === 'attempts_exhausted' || orchestration.kind === 'broken')
    && shouldDeferAliasRuntimeFailure(requestMeta, res)
  ) {
    return createAliasRuntimeFailureResult({
      requestMeta,
      provider,
      model: String(requestJson && requestJson.model || '').trim(),
      statusCode: attemptMutable.finalStatusCode,
      error: attemptMutable.lastError || 'upstream_failed',
      detail: attemptMutable.lastError,
      attemptedAccountRefs: Array.from(orchestration.attemptedAccountRefs || [])
    });
  }

  state.metrics.totalFailures += 1;
  state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
  pushMetricError(state.metrics, routeKey, provider, {
    message: attemptMutable.lastError,
    error: attemptMutable.lastError || 'upstream_failed',
    attemptedAccountRefs: Array.from(orchestration.attemptedAccountRefs || []),
    model: (requestJson && requestJson.model) || (requestMeta && requestMeta.model) || '',
    sessionId: requestMeta && (requestMeta.sessionId || requestMeta.sessionKey),
    projectPath: requestMeta && requestMeta.projectPath,
    projectDirName: requestMeta && requestMeta.projectDirName
  });
  if (options.logRequests) {
    appendProxyRequestLog({
      at: new Date().toISOString(),
      requestId: requestMeta && requestMeta.requestId,
      route: routeKey,
      provider,
      status: attemptMutable.finalStatusCode,
      error: attemptMutable.lastError,
      streamRequested,
      streamTransport: attemptMutable.streamTransport,
      durationMs: Date.now() - requestStartedAt
    });
  }
  writeJson(res, attemptMutable.finalStatusCode, { ok: false, error: 'upstream_failed', detail: attemptMutable.lastError });
}

module.exports = {
  handleUpstreamModels,
  handleUpstreamPassthrough,
  __private: {
    resolveProviderUpstream,
    resolveProviderPath
  }
};
