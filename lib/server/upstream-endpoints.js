'use strict';

const { createAttemptMiddleware, createAttemptObserver, resolvePluginAccountPreference } = require('./gateway-plugin-stage');
const { withAttemptAnnotations } = require('./attempt-annotations');
const { resolveRequestProvider, normalizeExplicitProvider } = require('./router');
const { isApiCredentialAccount } = require('../account/runtime-auth-mode');
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
const { guardNonVisionImagePayload } = require('./vision-image-guard');
const {
  resolveProviderProtocolRoutePlan
} = require('./provider-protocol-routing');
const {
  compactProviderProtocolPlan,
  createProviderProtocolPlan
} = require('./provider-protocol-plan');
const {
  discoverProviderModels,
  buildModelDiscoverySignature
} = require('./provider-model-discovery');
const {
  getWebUiModelsCache
} = require('./webui-model-cache');
const {
  refreshStaleAgyUsageSnapshotsForPool
} = require('./agy-usage-snapshot');
const {
  createRequestAccountFailureRecorder
} = require('./request-account-failure-recorder');
const {
  DEFAULT_REQUEST_BUDGET_MS,
  DEFAULT_RETRY_DELAY_MS,
  decideTransientPoolRetry
} = require('./request-pool-retry-policy');
const { isCodeAssistProvider } = require('./upstream-endpoints-utils');
const { buildModelListEntries } = require('./upstream-endpoints-models');
const { buildCatalogVisibility } = require('./model-catalog-visibility');
const { resolveProviderUpstream, resolveProviderPath, isGeminiStreamGenerateContentPath } = require('./upstream-endpoints-path');
const { sendRawUpstreamResponse } = require('./upstream-endpoints-headers');
const { selectAccountsForRequestModel, writeNoModelAccountResponse, shouldDeferAliasRuntimeFailure, createAliasRuntimeFailureResult, applyFailurePolicyToAccount } = require('./upstream-endpoints-failure');
const { createRouteObserver } = require('./route-observer');
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
    res.setHeader('cache-control', 'private, max-age=30, stale-while-revalidate=300');
    const ids = Array.isArray(cacheState.ids) ? cacheState.ids : [];
    if (ids.length === 0 && cacheState.firstError) {
      res.setHeader('x-aih-models-fallback', '1');
    }
    // 对外口径 = 可见可用（至少一个启用账号能服务）。WebUI 模型管理另有全量口径。
    // 每次应答都按「当前运行池」现算，所以账号一被关闭，下一个请求就看不到它的模型，
    // 不依赖后台刷新是否跑完（缓存里仍然留着它的目录，只是不再对外发布）。
    const visibility = buildCatalogVisibility(state, options);
    res.setHeader('x-aih-models-scope', 'available');
    res.setHeader('x-aih-models-visible-accounts', String(visibility.accountRefs.size));
    // 被隐藏的账号 = 缓存里有模型目录、但此刻不在对外可见集合里的账号（关闭 / 删除 /
    // 被策略挡掉）。这是「对外目录为什么比 WebUI 短」的直接现场证据。
    if (visibility.known) {
      const hiddenAccounts = Object.keys(cacheState.byAccount || {})
        .filter((accountRef) => !visibility.accountRefs.has(String(accountRef || '').trim()))
        .length;
      if (hiddenAccounts > 0) {
        res.setHeader('x-aih-models-hidden-accounts', String(hiddenAccounts));
      }
    }
    res.end(JSON.stringify(buildOpenAIModelsList(buildModelListEntries(
      ids,
      modelCatalogSettings || state.modelCatalogSettings,
      options,
      FALLBACK_MODELS,
      cacheState.byAccount,
      state,
      visibility
    ))));
  };

  // Probe every candidate account upstream and refresh the shared cache. Slow
  // (real HTTP to each provider); callers decide whether to await it.
  const runDiscoveryAndCache = async () => {
    const discovery = await discoverProviderModels({
      state,
      options,
      fs: deps.fs,
      aiHomeDir: deps.aiHomeDir,
      hostHomeDir: deps.hostHomeDir,
      processObj: deps.processObj,
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

  // The WebUI catalog is persisted across restarts and is built from the same
  // account/model discovery chain.  Reuse its provider projection as the
  // first response after a restart, then let the normal single-flight refresh
  // replace it.  This removes the cold-start dependency on every upstream
  // /models endpoint while preserving live refresh semantics.
  const persistedProviderModels = state.webUiModelsCache
    && state.webUiModelsCache.byProvider
    && Array.isArray(state.webUiModelsCache.byProvider[providerMode])
    ? state.webUiModelsCache.byProvider[providerMode].filter(Boolean)
    : [];
  if (!hasUsableCache && persistedProviderModels.length > 0) {
    state.modelsCache = {
      updatedAt: Number(state.webUiModelsCache.updatedAt) || now,
      ids: Array.from(new Set(persistedProviderModels.map((id) => String(id).trim()).filter(Boolean))).sort(),
      byProvider: { [providerMode]: persistedProviderModels.slice() },
      byAccount: state.webUiModelsCache.byAccount || {},
      sourceCount: Number(state.webUiModelsCache.sourceCount) || 0,
      scannedAccounts: Number(state.webUiModelsCache.scannedAccounts) || 0,
      firstError: String(state.webUiModelsCache.firstError || ''),
      source: 'persisted-webui',
      signature
    };
    res.setHeader('x-aih-models-cache', 'persisted');
    sendCachedPayload(state.modelsCache);
    scheduleBackgroundRefresh();
    return;
  }

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
    refreshKimiAccessToken,
    accountActivity
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
    // 上游说出的恢复时刻（毫秒，0 = 没给）：只有 429 才用它，见下方最终失败交付。
    finalRetryAfterMs: 0,
    transientPoolRetryUsed: false,
    transientPoolRetryDeadlineAt: 0,
    // 本次请求里已经因网络类失败而失败的**出口身份**（见 attempt 的 accountEgressIdentity）：
    // 同一个出口换号只会白等一次 5s 超时，不同出口才值得再试。
    networkFailedEgresses: new Set()
  };
  // 请求级日志出口的**唯一通道**：与 transport 的日志出口共用同一注解袋子，
  // 因此 attempt 期间记录的任何注解都会随这里落盘（见 attempt-annotations）。
  const logRequest = (entry) => {
    if (!options.logRequests) return;
    appendProxyRequestLog(withAttemptAnnotations(entry, attemptMutable));
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
  // 运行态变更统一走门禁（见 account-runtime-gate）：成功与失败都只经这一个出口，
  // 未装配门禁时退回原有的 markProxyAccount* 直调（单测/降级装配）。
  const runtimeGate = deps.accountRuntimeGate && typeof deps.accountRuntimeGate.observeFailure === 'function'
    ? deps.accountRuntimeGate
    : null;
  const recordAccountSuccess = (account, model = requestedModel) => {
    if (runtimeGate && typeof runtimeGate.observeSuccess === 'function') {
      runtimeGate.observeSuccess({ account, provider, model, source: 'server.upstream.success' });
    } else {
      markProxyAccountSuccess(account, { model });
    }
    requestAccountFailures.recordSuccess(account);
    requestSucceeded = true;
    state.metrics.totalSuccess += 1;
    state.metrics.providerSuccess[provider] = Number(state.metrics.providerSuccess[provider] || 0) + 1;
  };
  const requestAccountFailures = createRequestAccountFailureRecorder((account, policy) => {
    if (runtimeGate) {
      runtimeGate.observeFailure({
        account,
        provider,
        policy,
        model: requestedModel,
        defaultThreshold: options.failureThreshold,
        source: 'server.upstream.failure'
      });
      return;
    }
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
    // 用量快照刷新是「后台观测」，不能挡在推理请求前面：整池刷新会把每个未命中
    // 60s TTL 的账号都串进首字节延迟（实测不钉选时 2–20s，钉选单账号时 1.5–2.7s）。
    // 这里只触发刷新，选择仍按当前快照进行；真遇到配额耗尽，请求失败后的
    // scheduleAgyUsageRefreshAfterFailure 会再把该账号刷新回来。
    void refreshStaleAgyUsageSnapshotsForPool({
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
    options,
    { aliasMatched: Boolean(requestMeta && requestMeta.aliasResolution
      && requestMeta.aliasResolution.aliasMatched === true) }
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
      aliasPoolExhausted: modelPoolSelection.aliasPoolExhausted === true,
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
  const refreshCodeAssistAfterAuthFailure = async (error, account, requestOptions = options) => {
    if (String(error && error.code || '').trim().toUpperCase() !== 'HTTP_401') return null;
    if (res.headersSent || res.writableEnded) return null;
    if (typeof refreshProviderAccessToken !== 'function' || isApiCredentialAccount(account)) return null;
    const accountRef = String(account && account.accountRef || '').trim();
    if (!accountRef || forcedRefreshRetryUsed.has(accountRef)) return null;
    // 有别的账号可用时，401 的第一动作应该是换号，而不是把整个请求卡在刷新上。
    // agy 的刷新端点在网络/凭据异常时可能连续尝试多个 client（每个 15s 超时），
    // 实测一次冷启动首请求会被拖到 30s+；这里把刷新放到后台，当前请求立即
    // failover，凭据刷新成功后再由后续探测/请求把该账号重新纳入调度。
    if (!requestedAccountRef && pool.length > 1) {
      void refreshProviderAccessToken(account, {
        force: true,
        timeoutMs: Math.min(Number(requestOptions.upstreamTimeoutMs) || 5000, 5000),
        proxyUrl: requestOptions.proxyUrl,
        noProxy: requestOptions.noProxy
      }, {
        fetchWithTimeout
      }).catch(() => null);
      return null;
    }

    let refreshResult = null;
    try {
      refreshResult = await refreshProviderAccessToken(account, {
        force: true,
        timeoutMs: requestOptions.upstreamTimeoutMs,
        proxyUrl: requestOptions.proxyUrl,
        noProxy: requestOptions.noProxy
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
  // 插件账号策略：只对已筛出的候选给偏好顺序（宿主规则仍优先）；没有插件时立即返回。
  const pluginAccountPolicy = await resolvePluginAccountPreference({
    requestMeta, pool, provider, model: String(requestJson && requestJson.model || '').trim(), res, writeJson
  });
  if (pluginAccountPolicy.handled) return;
  const orchestration = await runWithAccountAttempts({
    pool,
    preferredAccountRefs: pluginAccountPolicy.preferredAccountRefs,
    observeAttempt: createAttemptObserver({ requestMeta, provider: provider, model: String(requestJson && requestJson.model || '').trim(), res }),
    wrapAttempt: createAttemptMiddleware({ requestMeta, provider: provider, model: String(requestJson && requestJson.model || '').trim(), res, writeJson }),
    maxAttempts,
    chooseServerAccount,
    selectionState: state,
    cursorState: state.cursors,
    cursorKey: provider,
    provider,
    model: String(requestJson && requestJson.model || '').trim(),
    strategy: state.strategy,
    sessionKey: (requestMeta && requestMeta.sessionKey) || '',
    // 路由观测：把「本次请求落到哪个账号」落盘，供网关模式的终端标题读回
    // （构造与纪律见 lib/server/route-observer.js）。
    observeRoute: createRouteObserver({ requestMeta, fs: deps.fs, aiHomeDir: deps.aiHomeDir || options.aiHomeDir, providerSessionStateStore: deps.providerSessionStateStore }),
    // Last-resort: when the alias preflight found every candidate only soft
    // (model) cooled, serve through a model-cooled account instead of 503'ing.
    allowModelCooled: Boolean(requestMeta && requestMeta.allowModelCooled),
    accountActivity,
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
          logRequest({
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
  // 上游说出的恢复时刻要交给客户端：免费档的日额度 429 只有 retry-after 能让客户端按
  // 正确时刻退避（否则它会立刻或按自己的固定间隔再撞）。只在 429 上带 —— 别的失败类型
  // 可能复用上一次 attempt 留下的值（attemptMutable 是请求级的，不随 attempt 重置）。
  // 只用在「把上游那次失败原样交回客户端」的两条分支上；按账号可用性合成的响应有自己的
  // retryAfterSeconds，不要拿上游的值去覆盖它。
  const retryAfterSeconds = attemptMutable.finalStatusCode === 429
    ? Math.max(0, Math.ceil((Number(attemptMutable.finalRetryAfterMs) || 0) / 1000))
    : 0;
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
      logRequest({
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
      if (retryAfterSeconds > 0 && typeof res.setHeader === 'function') {
        res.setHeader('retry-after', String(retryAfterSeconds));
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
    logRequest({
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
  logRequest({
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
  // 上游说出的恢复时刻已经在上面算好（retryAfterSeconds）：这里只把它带进响应体，
  // 头由上面那条 setHeader 写。
  if (retryAfterSeconds > 0 && typeof res.setHeader === 'function') {
    res.setHeader('retry-after', String(retryAfterSeconds));
  }
  writeJson(res, attemptMutable.finalStatusCode, {
    ok: false,
    error: 'upstream_failed',
    detail: attemptMutable.lastError,
    ...(retryAfterSeconds > 0 ? { retryAfterSeconds } : {})
  });
}

module.exports = {
  handleUpstreamModels,
  handleUpstreamPassthrough,
  __private: {
    resolveProviderUpstream,
    resolveProviderPath
  }
};
