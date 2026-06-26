'use strict';
const { extractRequestSessionKey } = require('./session-key');
const {
  detectClientProtocol,
  normalizePathname
} = require('./protocol-registry');
const {
  createFallbackProtocolRequest,
  createMemoryResponse,
  runFallbackProtocolBridge,
  runClientProtocolViaProviderProtocolRoute,
  withEffectiveProvider
} = require('./protocol-fallback-bridge');
const { extractGeminiModelFromPath } = require('./protocol-adapters');
const { loadAliases } = require('./model-alias-store');
const { createAnthropicTokenCountResponse } = require('./anthropic-token-count');
const {
  normalizeModelCatalogSettings,
  loadModelCatalogSettings
} = require('./model-catalog-settings-store');
const {
  applyAliasCandidate,
  resolveModelAliasCandidates
} = require('./model-alias-resolver');
const { resolveGatewayProvider } = require('./capability-router');
const {
  buildGatewayModelEntries,
  mergeGatewayModelEntries
} = require('./gateway-model-list');
const { resolveProviderProtocolRouteForClientRequest } = require('./provider-protocol-routing');
const { refreshWebUiModelsCache } = require('./webui-model-cache');
const {
  buildModelCapabilityIndex,
  modelHasRoutableProvider,
  modelHasAvailableProvider,
  summarizeModelProviderCooldown
} = require('./model-capability-index');
const { buildModelDiscoverySignature } = require('./provider-model-discovery');
const { validateAliasTarget } = require('./model-alias-validation');
const { refreshStaleAgyUsageSnapshotsForPool } = require('./agy-usage-snapshot');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');

function rewriteRequestUrlPathname(req, pathname) {
  if (!req || typeof req !== 'object') return req;
  const originalUrl = String(req.url || '');
  const safePathname = String(pathname || '').trim() || '/';
  const queryIndex = originalUrl.indexOf('?');
  const query = queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';
  return {
    ...req,
    url: `${safePathname}${query}`
  };
}

function sanitizeUndefinedSentinel(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeUndefinedSentinel(item))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && value.trim() === '[undefined]') return undefined;
    return value;
  }
  const out = {};
  Object.entries(value).forEach(([key, item]) => {
    const sanitized = sanitizeUndefinedSentinel(item);
    if (sanitized === undefined) return;
    out[key] = sanitized;
  });
  return out;
}

function parseOpenAIModelIdsFromBody(bodyText) {
  const text = String(bodyText || '').trim();
  if (!text) return [];
  try {
    const payload = JSON.parse(text);
    const list = Array.isArray(payload && payload.data) ? payload.data : [];
    return list
      .map((item) => String(item && item.id || '').trim())
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function writeLocalJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function incrementRouteMetrics(state, routeKey) {
  const metrics = state && state.metrics;
  if (!metrics) return;
  metrics.totalRequests = Number(metrics.totalRequests || 0) + 1;
  if (!metrics.routeCounts || typeof metrics.routeCounts !== 'object') {
    metrics.routeCounts = {};
  }
  metrics.routeCounts[routeKey] = Number(metrics.routeCounts[routeKey] || 0) + 1;
}

function writeGatewayProviderUnavailable(res, result, clientProtocol, aliasResolution) {
  const alias = aliasResolution && typeof aliasResolution === 'object' ? aliasResolution : {};
  const resultError = String(result && result.error || '').trim();
  const error = resultError === 'alias_target_model_not_in_catalog'
    || resultError === 'missing_model'
    || resultError === 'model_disabled'
    ? resultError
    : 'no_available_account';
  const statusCode = error === 'missing_model' ? 400 : 503;
  try {
    console.warn(JSON.stringify({
      at: new Date().toISOString(),
      kind: 'gateway_provider_unavailable',
      error,
      detail: String(result && result.detail || ''),
      clientProtocol: String(clientProtocol || ''),
      requestedModel: String(alias.requestedModel || result && result.model || ''),
      aliasMatched: Boolean(alias.aliasMatched),
      aliasId: String(alias.aliasId || ''),
      aliasTarget: String(alias.aliasTarget || ''),
      effectiveModel: String(alias.effectiveModel || result && result.model || ''),
      effectiveProvider: String(alias.effectiveProvider || ''),
      familyProvider: String(result && result.familyProvider || '')
    }));
  } catch (_error) {}
  writeLocalJson(res, statusCode, {
    ok: false,
    error,
    detail: String(result && result.detail || 'no account in the global pool can serve this request'),
    clientProtocol: String(clientProtocol || ''),
    model: String(result && result.model || ''),
    alias: {
      matched: Boolean(alias.aliasMatched),
      id: String(alias.aliasId || ''),
      requestedModel: String(alias.requestedModel || ''),
      target: String(alias.aliasTarget || ''),
      effectiveModel: String(alias.effectiveModel || result && result.model || ''),
      effectiveProvider: String(alias.effectiveProvider || '')
    },
    familyProvider: String(result && result.familyProvider || ''),
    availability: result && result.availability ? result.availability : undefined
  });
}

function requireGatewayProvider(res, input) {
  const result = resolveGatewayProvider(input);
  if (result && result.provider) return result.provider;
  writeGatewayProviderUnavailable(res, result, input && input.clientProtocol, input && input.aliasResolution);
  return '';
}

// 按优先级顺序逐个校验别名候选的 target 是否在真实目录中有可用账号,选中第一个可用候选。
// 全部失败时强刷一次模型缓存再整轮重试;仍失败则返回已尝试列表用于 502 详情。
async function selectAvailableAliasCandidate(input = {}) {
  const {
    candidates,
    aliases,
    state,
    options,
    fetchModelsForAccount
  } = input;
  const orderedCandidates = Array.isArray(candidates) ? candidates : [];
  if (orderedCandidates.length === 0) {
    return { matched: false, candidate: null, tried: [] };
  }

  const tryAllCandidates = () => {
    const modelCapabilityIndex = buildModelCapabilityIndex(state || {}, options || {});
    const now = Date.now();
    const tried = [];
    // Highest-priority candidate that has a real (non-hard-down) account but is
    // only soft model-cooled — kept as a last resort if nothing is cleanly routable.
    let lastResortCandidate = null;
    for (const candidate of orderedCandidates) {
      const result = validateAliasTarget({
        id: candidate.id,
        alias: candidate.alias,
        target: candidate.target,
        provider: candidate.provider,
        targetProvider: candidate.targetProvider,
        enabled: true
      }, {
        aliases,
        state,
        options,
        modelCapabilityIndex
      });
      if (result.ok) {
        // Runtime-aware fallback: the target is in the catalog, but if EVERY
        // backing account is currently rate-limited for this exact model, skip
        // to the next (lower-priority) alias candidate instead of forcing a 429.
        const providers = Array.isArray(result.providers) && result.providers.length > 0
          ? result.providers
          : [candidate.targetProvider].filter(Boolean);
        const routable = providers.some((provider) => modelHasRoutableProvider(modelCapabilityIndex, candidate.target, provider, now));
        if (routable) return { candidate, tried, lastResortCandidate: null };
        // Not cleanly routable, but if a backing account exists and is only soft
        // model-cooled (not auth/hard-down), remember it as a last resort so we
        // serve the request rather than 503'ing the client.
        if (!lastResortCandidate) {
          const lastResortOk = providers.some((provider) => modelHasAvailableProvider(modelCapabilityIndex, candidate.target, provider, now));
          if (lastResortOk) lastResortCandidate = candidate;
        }
        // Carry the real per-account reason (e.g. transient_network: fetch
        // failed) into the diagnostic so the 503 explains itself instead of
        // leaving the caller to guess behind a bare "cooling down" label.
        const cooldownSummary = providers
          .map((provider) => summarizeModelProviderCooldown(modelCapabilityIndex, candidate.target, provider, now))
          .filter(Boolean)
          .join(' | ');
        tried.push(buildTriedAliasCandidate(candidate, {
          error: 'alias_target_all_accounts_cooling_down',
          detail: cooldownSummary
            ? `all accounts for ${candidate.target} are temporarily rate-limited/cooling down - ${cooldownSummary}`
            : `all accounts for ${candidate.target} are temporarily rate-limited/cooling down`
        }));
        continue;
      }
      tried.push(buildTriedAliasCandidate(candidate, result));
    }
    return { candidate: null, tried, lastResortCandidate };
  };

  let attempt = tryAllCandidates();
  if (!attempt.candidate && !attempt.lastResortCandidate && typeof fetchModelsForAccount === 'function') {
    await refreshWebUiModelsCache(state, options || {}, {
      fetchModelsForAccount,
      accountLimit: 8
    }).catch(() => {});
    attempt = tryAllCandidates();
  }
  if (attempt.candidate) {
    return { matched: true, candidate: attempt.candidate, tried: attempt.tried };
  }
  // Last resort: every candidate is merely model-cooled (rate_limited /
  // model_cooldown), not hard-down. A cooldown is a load-spreading hint, and the
  // model has very likely recovered — serve the highest-priority such candidate
  // with allowModelCooled instead of returning no_available_account to the client.
  if (attempt.lastResortCandidate) {
    return {
      matched: true,
      candidate: attempt.lastResortCandidate,
      tried: attempt.tried,
      lastResort: true
    };
  }
  return { matched: true, candidate: null, tried: attempt.tried };
}

function formatTriedAliasTargets(tried) {
  return (Array.isArray(tried) ? tried : [])
    .map((item) => `${item.target}(priority=${item.priority})`)
    .join(', ');
}

function buildTriedAliasCandidate(candidate, failure) {
  return {
    id: String(candidate && candidate.id || ''),
    alias: String(candidate && candidate.alias || ''),
    provider: String(candidate && candidate.provider || ''),
    targetProvider: String(candidate && candidate.targetProvider || ''),
    target: String(candidate && candidate.target || ''),
    priority: Number(candidate && candidate.priority) || 0,
    error: String(failure && failure.error || ''),
    detail: String(failure && failure.detail || '')
  };
}

function findCandidateForTriedAlias(tried, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const id = String(tried && tried.id || '').trim();
  if (id) {
    const byId = list.find((candidate) => String(candidate && candidate.id || '') === id);
    if (byId) return byId;
  }

  const target = String(tried && tried.target || '').trim();
  if (!target) return list[0] || null;
  const priority = Number(tried && tried.priority);
  if (Number.isFinite(priority)) {
    const byTargetAndPriority = list.find((candidate) => (
      String(candidate && candidate.target || '').trim() === target
      && Number(candidate && candidate.priority || 0) === priority
    ));
    if (byTargetAndPriority) return byTargetAndPriority;
  }
  return list.find((candidate) => String(candidate && candidate.target || '').trim() === target) || list[0] || null;
}

function isAliasRuntimeFailureResult(result) {
  return Boolean(result && result.retryAliasCandidate);
}

function formatAliasRuntimeFailureTarget(failure) {
  const alias = failure && failure.alias && typeof failure.alias === 'object' ? failure.alias : {};
  const target = String(alias.target || failure && failure.model || '').trim();
  const statusCode = Number(failure && failure.statusCode || 0);
  const status = statusCode ? `status=${statusCode}` : 'status=unknown';
  return target ? `${target}(${status})` : `unknown(${status})`;
}

function writeAliasRuntimeFailure(res, writeJson, failure, previousFailures = [], orderedFailures = null) {
  const statusCode = Number(failure && failure.statusCode || 502);
  const alias = failure && failure.alias && typeof failure.alias === 'object' ? failure.alias : {};
  const tried = Array.isArray(orderedFailures) && orderedFailures.length > 0
    ? orderedFailures.filter(Boolean)
    : [...(Array.isArray(previousFailures) ? previousFailures : []), failure].filter(Boolean);
  const triedTargets = tried.map((item) => formatAliasRuntimeFailureTarget(item));
  writeJson(res, statusCode, {
    ok: false,
    error: String(failure && failure.error || 'upstream_failed'),
    detail: String(failure && failure.detail || 'upstream request failed'),
    alias: {
      matched: true,
      id: String(alias.id || ''),
      requestedModel: String(alias.requestedModel || ''),
      target: String(alias.target || ''),
      effectiveModel: String(failure && failure.model || alias.target || ''),
      effectiveProvider: String(failure && failure.provider || '')
    },
    triedAliasTargets: triedTargets
  });
}

function readHeaderValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const target = String(name || '').trim().toLowerCase();
  if (!target) return '';
  const direct = headers[target];
  if (direct !== undefined && direct !== null) {
    return Array.isArray(direct) ? String(direct[0] || '').trim() : String(direct || '').trim();
  }
  const foundKey = Object.keys(headers).find((key) => String(key || '').trim().toLowerCase() === target);
  if (!foundKey) return '';
  const value = headers[foundKey];
  return Array.isArray(value) ? String(value[0] || '').trim() : String(value || '').trim();
}

async function readModelAliases(state, deps = {}) {
  if (deps && typeof deps.loadAliases === 'function' && deps.fs && deps.aiHomeDir) {
    const data = await deps.loadAliases(deps.fs, deps.aiHomeDir);
    state.modelAliases = data;
    return data;
  }
  if (deps && deps.fs && deps.aiHomeDir) {
    const data = await loadAliases(deps.fs, deps.aiHomeDir);
    state.modelAliases = data;
    return data;
  }
  return state.modelAliases && Array.isArray(state.modelAliases.aliases)
    ? state.modelAliases
    : { aliases: [] };
}

async function readModelCatalogSettings(state, deps = {}) {
  if (deps && typeof deps.loadModelCatalogSettings === 'function' && deps.fs && deps.aiHomeDir) {
    const data = await deps.loadModelCatalogSettings(deps.fs, deps.aiHomeDir);
    state.modelCatalogSettings = data;
    return data;
  }
  if (deps && deps.fs && deps.aiHomeDir) {
    const data = await loadModelCatalogSettings(deps.fs, deps.aiHomeDir);
    state.modelCatalogSettings = data;
    return data;
  }
  return normalizeModelCatalogSettings(state.modelCatalogSettings);
}

function parseV1ClientKey(headers, parseAuthorizationBearer) {
  const authKey = typeof parseAuthorizationBearer === 'function'
    ? parseAuthorizationBearer(readHeaderValue(headers, 'authorization'))
    : '';
  return authKey || readHeaderValue(headers, 'x-api-key');
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch (_error) {
    return String(value || '');
  }
}

function getModelIdFromModelsPath(pathname) {
  const match = String(pathname || '').match(/^\/v1\/models\/([^/]+)$/);
  if (!match) return '';
  return decodePathSegment(match[1]).trim();
}

async function collectModelIdsFromHandler(handler, baseCtx) {
  if (typeof handler !== 'function') return { ids: [], statusCode: 500, body: '' };
  const memoryRes = createMemoryResponse();
  await handler({
    ...baseCtx,
    res: memoryRes
  });
  return {
    ids: parseOpenAIModelIdsFromBody(memoryRes.body),
    statusCode: Number(memoryRes.statusCode || 0),
    body: memoryRes.body
  };
}

async function handleV1Request(ctx) {
  const {
    req,
    res,
    method,
    pathname: rawPathname,
    options,
    state,
    requiredClientKey,
    cooldownMs,
    maxRequestBodyBytes,
    requestMeta,
    deps
  } = ctx;
  const pathname = normalizePathname(rawPathname);
  const routingReq = pathname === rawPathname ? req : rewriteRequestUrlPathname(req, pathname);

  const {
    parseAuthorizationBearer,
    writeJson,
    readRequestBody,
    buildOpenAIModelsList,
    resolveRequestProvider,
    chooseServerAccount,
    markProxyAccountSuccess,
    markProxyAccountFailure,
    pushMetricError,
    appendProxyRequestLog,
    handleUpstreamModels,
    handleUpstreamPassthrough,
    handleCodexModels,
    handleCodexChatCompletions,
    fetchModelsForAccount,
    fetchGeminiCodeAssistChatCompletion,
    fetchGeminiCodeAssistChatCompletionStream,
    fetchGeminiCodeAssistGenerateContent,
    fetchGeminiCodeAssistGenerateContentStream,
    fetchCodeAssistAnthropicMessage,
    fetchCodeAssistAnthropicMessageStream,
    fetchOpenCodeChatCompletion,
    fetchOpenCodeChatCompletionStream,
    FALLBACK_MODELS,
    fetchWithTimeout,
    refreshCodexAccessToken,
    recordModelUsage
  } = deps;

  if (!pathname.startsWith('/v1/') && !pathname.startsWith('/v1beta/')) return false;

  if (requiredClientKey) {
    const incoming = parseV1ClientKey(req.headers, parseAuthorizationBearer);
    if (incoming !== requiredClientKey) {
      writeJson(res, 401, { ok: false, error: 'unauthorized_client' });
      return true;
    }
  }

  const bodyBufferResult = await readRequestBody(req, { maxBytes: maxRequestBodyBytes }).catch((error) => ({ __error: error }));
  if (!bodyBufferResult || bodyBufferResult.__error) {
    const err = bodyBufferResult && bodyBufferResult.__error;
    if (err && err.code === 'request_body_too_large') {
      writeJson(res, 413, { ok: false, error: 'request_body_too_large' });
      return true;
    }
    writeJson(res, 400, { ok: false, error: 'invalid_request_body' });
    return true;
  }
  const bodyBuffer = bodyBufferResult;

  let requestJson = null;
  try {
    requestJson = bodyBuffer.length > 0 ? JSON.parse(bodyBuffer.toString('utf8')) : {};
  } catch (e) {
    requestJson = {};
  }
  console.log(`[aih] Incoming request: ${method} ${pathname}, model requested: ${requestJson && requestJson.model || 'none'}`);
  let upstreamBodyBuffer = bodyBuffer;
  if (requestJson && typeof requestJson === 'object' && bodyBuffer.length > 0) {
    try {
      const sanitizedRequest = sanitizeUndefinedSentinel(requestJson);
      if (sanitizedRequest && typeof sanitizedRequest === 'object') {
        upstreamBodyBuffer = Buffer.from(JSON.stringify(sanitizedRequest));
        requestJson = sanitizedRequest;
      }
    } catch (_error) {
      upstreamBodyBuffer = bodyBuffer;
    }
  }

  const clientProtocol = detectClientProtocol(method, pathname);
  if (clientProtocol === 'anthropic_count_tokens') {
    const routeKey = `${method} ${pathname}`;
    incrementRouteMetrics(state, routeKey);
    if (state && state.metrics) {
      state.metrics.totalSuccess = Number(state.metrics.totalSuccess || 0) + 1;
    }
    writeLocalJson(res, 200, createAnthropicTokenCountResponse(requestJson || {}));
    return true;
  }

  const modelAliasData = await readModelAliases(state, deps);
  const modelCatalogSettings = await readModelCatalogSettings(state, deps);
  const aliasCandidatesContext = resolveModelAliasCandidates({
    aliases: modelAliasData.aliases,
    requestJson,
    clientProtocol,
    resolveRequestProvider: deps.resolveRequestProvider,
    options,
    headers: routingReq && routingReq.headers,
    state
  });
  if (
    aliasCandidatesContext.candidates.some((candidate) => String(candidate && candidate.targetProvider || '').trim() === 'agy')
    && state
    && state.accounts
    && Array.isArray(state.accounts.agy)
  ) {
    await refreshStaleAgyUsageSnapshotsForPool({
      pool: state.accounts.agy,
      options,
      fs: deps.fs,
      fetchWithTimeout
    }).catch(() => null);
  }
  const originalRequestJson = requestJson;
  const originalUpstreamBodyBuffer = upstreamBodyBuffer;
  const createResolvedRouteInput = (candidate, remainingCandidates = [], routeOptions = {}) => {
    const aliasContext = applyAliasCandidate({
      requestJson: originalRequestJson,
      candidate,
      baseProvider: aliasCandidatesContext.baseProvider
    });
    const nextBodyBuffer = aliasContext.changed
      ? Buffer.from(JSON.stringify(aliasContext.requestJson))
      : originalUpstreamBodyBuffer;
    const fallbackCandidates = (Array.isArray(remainingCandidates) ? remainingCandidates : [])
      .filter((item) => item && candidate && item.id !== candidate.id);
    return {
      requestJson: aliasContext.requestJson,
      upstreamBodyBuffer: nextBodyBuffer,
      aliasResolution: aliasContext.aliasResolution,
      aliasTargetProvider: aliasContext.aliasTargetProvider,
      preferModelRouting: aliasContext.preferModelRouting,
      allowModelCooled: Boolean(routeOptions && routeOptions.allowModelCooled),
      aliasRuntimeFallback: aliasContext.changed && fallbackCandidates.length > 0
        ? {
            enabled: true,
            candidateId: String(candidate.id || ''),
            requestedModel: String(aliasContext.aliasResolution.requestedModel || ''),
            target: String(candidate.target || ''),
            provider: String(aliasContext.aliasTargetProvider || candidate.targetProvider || ''),
            model: String(aliasContext.requestJson && aliasContext.requestJson.model || '')
          }
        : null
    };
  };

  const writeUnavailableAliasSelection = (aliasSelection, candidates, previousRuntimeFailures = []) => {
    const firstTried = aliasSelection.tried[0] || {};
    const failedCandidate = findCandidateForTriedAlias(firstTried, candidates);
    const failedAliasResolution = applyAliasCandidate({
      requestJson: originalRequestJson,
      candidate: failedCandidate,
      baseProvider: aliasCandidatesContext.baseProvider
    }).aliasResolution;
    const triedSuffix = aliasSelection.tried.length > 1
      ? `; tried targets: ${formatTriedAliasTargets(aliasSelection.tried)}`
      : '';
    const error = String(firstTried.error || '').trim() || 'alias_target_model_not_in_catalog';
    const detail = `${firstTried.detail || `alias target model ${firstTried.target || ''} is not present in the real provider account model catalog`}${triedSuffix}`;
    const selectionFailure = {
      ok: false,
      retryAliasCandidate: false,
      statusCode: error === 'missing_model' ? 400 : 503,
      error,
      detail,
      provider: String(failedAliasResolution.effectiveProvider || failedAliasResolution.aliasTargetProvider || ''),
      model: firstTried.target || aliasCandidatesContext.requestedModel,
      alias: {
        id: String(failedAliasResolution.aliasId || ''),
        requestedModel: String(failedAliasResolution.requestedModel || ''),
        target: String(failedAliasResolution.aliasTarget || firstTried.target || '')
      }
    };
    if (previousRuntimeFailures.length > 0) {
      const runtimeFailure = previousRuntimeFailures[previousRuntimeFailures.length - 1];
      writeAliasRuntimeFailure(
        res,
        writeJson,
        runtimeFailure,
        previousRuntimeFailures.slice(0, -1),
        previousRuntimeFailures.concat(selectionFailure)
      );
      return;
    }
    // The model-discovery scan's firstError (e.g. a 403 from one account while
    // listing models) only explains catalog/visibility failures. When every
    // target is merely cooling down at runtime, that scan error is unrelated
    // noise: surfacing it makes the 503 read like a permission problem. Only
    // include it for genuine catalog misses.
    const isCatalogFailure = error === 'alias_target_model_not_in_catalog';
    writeGatewayProviderUnavailable(res, {
      error,
      detail,
      model: selectionFailure.model,
      availability: state && state.webUiModelsCache
        ? {
            provider: 'catalog',
            source: String(state.webUiModelsCache.source || ''),
            scannedAccounts: Number(state.webUiModelsCache.scannedAccounts || 0),
            firstError: isCatalogFailure ? String(state.webUiModelsCache.firstError || '') : '',
            providers: state.webUiModelsCache.byProvider || {}
          }
        : undefined
    }, clientProtocol, failedAliasResolution);
  };

  let requestCounted = false;
  const countRequestOnce = (routeKey) => {
    if (requestCounted) return;
    requestCounted = true;
    incrementRouteMetrics(state, routeKey);
  };

  const runResolvedRequest = async (routeInput) => {
  const {
    requestJson,
    upstreamBodyBuffer,
    aliasResolution,
    aliasTargetProvider,
    preferModelRouting,
    aliasRuntimeFallback,
    allowModelCooled
  } = routeInput;
  const requestStartedAt = Date.now();
  const routeKey = `${method} ${pathname}`;
  const sessionKey = extractRequestSessionKey(routingReq.headers || {}, requestJson || {});
  const requestMetaWithSession = {
    ...(requestMeta || {}),
    sessionKey,
    aliasResolution,
    ...(aliasTargetProvider ? { effectiveProvider: aliasTargetProvider } : {}),
    ...(aliasRuntimeFallback ? { aliasRuntimeFallback } : {}),
    ...(allowModelCooled ? { allowModelCooled: true } : {})
  };
  countRequestOnce(routeKey);

  if (method === 'GET' && pathname === '/v1/models' && options.backend === 'codex-adapter') {
    const providerMode = String((options && options.provider) || 'auto').trim().toLowerCase();
    if (providerMode === 'codex') {
      await handleCodexModels({
        options,
        state,
        res,
        deps: {
          buildOpenAIModelsList,
          fetchWithTimeout,
          modelCatalogSettings
        }
      });
      return true;
    }
    if (SUPPORTED_SERVER_PROVIDERS.includes(providerMode)) {
      await handleUpstreamModels({
        options: { ...options, provider: providerMode },
        state,
        res,
        deps: {
          buildOpenAIModelsList,
          fetchModelsForAccount,
          FALLBACK_MODELS,
          modelCatalogSettings
        }
      });
      return true;
    }
    // auto mode merges every provider into one global capability pool. Probing
    // multiple providers upstream is multi-second work, so: (1) probe them in
    // parallel, not serially, and (2) cache the merged result with
    // stale-while-revalidate — only a cold cache pays the probe cost; every
    // other request returns the cached body instantly (<300ms) and refreshes in
    // the background when the cache has expired.
    const globalModelsTtl = Math.max(1000, Number(options.modelsCacheTtlMs) || 300000);
    const globalCandidateLimit = Math.max(1, Number(options.modelsProbeAccounts) || 2);
    const globalModelsSignature = `auto|${buildModelDiscoverySignature(state, {
      providerMode: 'auto',
      includeCodex: true
    })}|limit=${globalCandidateLimit}`;

    // Probe all providers concurrently and build the merged OpenAI list.
    const buildGlobalModelsResult = async () => {
      const upstreamProviders = SUPPORTED_SERVER_PROVIDERS.filter((provider) => provider !== 'codex');
      const [codexResult, ...upstreamResults] = await Promise.all([
        collectModelIdsFromHandler(handleCodexModels, {
          options,
          state,
          deps: { buildOpenAIModelsList, fetchWithTimeout, modelCatalogSettings }
        }),
        ...upstreamProviders.map((provider) => collectModelIdsFromHandler(handleUpstreamModels, {
          options: { ...options, provider },
          state: { ...state, modelsCache: { updatedAt: 0, ids: [], byAccount: {}, sourceCount: 0 } },
          deps: { buildOpenAIModelsList, fetchModelsForAccount, FALLBACK_MODELS, modelCatalogSettings }
        }))
      ]);
      const upstreamEntries = upstreamProviders.flatMap((provider, index) => {
        const result = upstreamResults[index] || { ids: [] };
        return result.ids.map((id) => ({ id, provider, source: 'remote' }));
      });
      const aliases = modelAliasData.aliases;
      const modelCapabilityIndex = buildModelCapabilityIndex(state, options);
      const mergedList = mergeGatewayModelEntries([
        ...buildGatewayModelEntries(state, options),
        ...codexResult.ids.map((id) => ({ id, provider: 'codex', source: 'remote' })),
        ...upstreamEntries
      ], aliases, { state, options, modelCapabilityIndex, modelCatalogSettings });
      return { codexResult, mergedList };
    };

    const storeGlobalModelsCache = (mergedList) => {
      state.globalModelsCache = {
        updatedAt: Date.now(),
        signature: globalModelsSignature,
        body: JSON.stringify(buildOpenAIModelsList(mergedList))
      };
      return state.globalModelsCache;
    };

    const sendGlobalModelsBody = (body, cacheState) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('x-aih-models-source', 'global-capability-pool');
      res.setHeader('x-aih-models-cache', cacheState);
      res.end(body);
    };

    const globalCache = state.globalModelsCache || {};
    const globalCacheFresh = globalCache.updatedAt > 0
      && Date.now() - globalCache.updatedAt < globalModelsTtl
      && globalCache.signature === globalModelsSignature
      && globalCache.body;

    if (globalCacheFresh) {
      sendGlobalModelsBody(globalCache.body, 'hit');
      return true;
    }

    if (globalCache.body) {
      // Stale (expired or inputs changed): serve the old body now, refresh once
      // in the background so the next caller sees fresh data.
      sendGlobalModelsBody(globalCache.body, 'stale');
      if (state.globalModelsRefreshing !== globalModelsSignature) {
        state.globalModelsRefreshing = globalModelsSignature;
        Promise.resolve()
          .then(buildGlobalModelsResult)
          .then(({ mergedList }) => {
            if (mergedList.length > 0) storeGlobalModelsCache(mergedList);
          })
          .catch(() => {})
          .finally(() => {
            if (state.globalModelsRefreshing === globalModelsSignature) {
              state.globalModelsRefreshing = null;
            }
          });
      }
      return true;
    }

    // Cold cache: probe synchronously this one time, then cache for next time.
    const { codexResult, mergedList } = await buildGlobalModelsResult();
    if (mergedList.length > 0) {
      const cached = storeGlobalModelsCache(mergedList);
      sendGlobalModelsBody(cached.body, 'miss');
      return true;
    }
    if (codexResult.statusCode >= 400 && codexResult.body) {
      res.statusCode = codexResult.statusCode;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(codexResult.body);
      return true;
    }
    await handleCodexModels({
      options,
      state,
      res,
      deps: {
        buildOpenAIModelsList,
        fetchWithTimeout,
        modelCatalogSettings
      }
    });
    return true;
  }

  const modelIdFromPath = method === 'GET' ? getModelIdFromModelsPath(pathname) : '';
  if (modelIdFromPath) {
    writeLocalJson(res, 200, {
      id: modelIdFromPath,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'aih-server'
    });
    return true;
  }

  if (method === 'GET' && pathname === '/v1/props') {
    writeLocalJson(res, 200, {
      object: 'props',
      data: {}
    });
    return true;
  }

  if (clientProtocol === 'anthropic_messages' && options.backend === 'codex-adapter') {
    const provider = requireGatewayProvider(res, {
      options,
      state,
      requestJson: requestJson || {},
      headers: routingReq && routingReq.headers,
      clientProtocol,
      aliasTargetProvider,
      preferModelRouting,
      aliasResolution
    });
    if (!provider) return true;
    const directRoute = resolveProviderProtocolRouteForClientRequest(clientProtocol, provider, requestJson || {});
    if (directRoute) {
      const routeResult = await runClientProtocolViaProviderProtocolRoute({
        clientProtocol,
        provider,
        route: directRoute,
        options,
        state,
        req: routingReq,
        res,
        method,
        routeKey,
        requestStartedAt,
        cooldownMs,
        requestJson,
        requestMeta: requestMetaWithSession,
        context: { pathname },
        deps: {
          chooseServerAccount,
          resolveRequestProvider,
          pushMetricError,
          writeJson,
          fetchWithTimeout,
          fetchModelsForAccount,
          fetchGeminiCodeAssistChatCompletion,
          fetchGeminiCodeAssistChatCompletionStream,
          fetchGeminiCodeAssistGenerateContent,
          fetchGeminiCodeAssistGenerateContentStream,
          fetchCodeAssistAnthropicMessage,
          fetchCodeAssistAnthropicMessageStream,
          fetchOpenCodeChatCompletion,
          fetchOpenCodeChatCompletionStream,
          markProxyAccountFailure,
          markProxyAccountSuccess,
          appendProxyRequestLog,
          refreshCodexAccessToken,
          recordModelUsage,
          handleCodexChatCompletions,
          handleUpstreamPassthrough
        }
      });
      if (isAliasRuntimeFailureResult(routeResult)) return routeResult;
      return true;
    }

    const bridgeRequest = createFallbackProtocolRequest(res, {
      clientProtocol,
      provider,
      payload: requestJson || {},
      context: { pathname }
    });
    if (!bridgeRequest) return true;
    const bridgeResult = await runFallbackProtocolBridge({
      clientProtocol,
      provider,
      options,
      state,
      req: routingReq,
      res,
      method,
      routeKey,
      requestStartedAt,
      cooldownMs,
      requestMeta: requestMetaWithSession,
      bridgeRequest,
      deps: {
        chooseServerAccount,
        resolveRequestProvider,
        pushMetricError,
        writeJson,
        fetchWithTimeout,
        fetchModelsForAccount,
        fetchGeminiCodeAssistChatCompletion,
        fetchGeminiCodeAssistChatCompletionStream,
        fetchGeminiCodeAssistGenerateContent,
        fetchGeminiCodeAssistGenerateContentStream,
        fetchCodeAssistAnthropicMessage,
        fetchCodeAssistAnthropicMessageStream,
        fetchOpenCodeChatCompletion,
        fetchOpenCodeChatCompletionStream,
        markProxyAccountFailure,
        markProxyAccountSuccess,
        appendProxyRequestLog,
        refreshCodexAccessToken,
        recordModelUsage,
        handleCodexChatCompletions,
        handleUpstreamPassthrough
      }
    });
    if (isAliasRuntimeFailureResult(bridgeResult)) return bridgeResult;
    return true;
  }

  if ((clientProtocol === 'gemini_generate_content' || clientProtocol === 'gemini_stream_generate_content') && options.backend === 'codex-adapter') {
    const geminiRouteRequestJson = {
      ...(requestJson || {}),
      model: extractGeminiModelFromPath(pathname) || requestJson && requestJson.model
    };
    const provider = requireGatewayProvider(res, {
      options,
      state,
      requestJson: geminiRouteRequestJson,
      headers: routingReq && routingReq.headers,
      clientProtocol,
      aliasTargetProvider,
      preferModelRouting,
      aliasResolution
    });
    if (!provider) return true;
    const directRoute = resolveProviderProtocolRouteForClientRequest(clientProtocol, provider, geminiRouteRequestJson);
    if (directRoute) {
      const routeResult = await runClientProtocolViaProviderProtocolRoute({
        clientProtocol,
        provider,
        options,
        state,
        req: routingReq,
        res,
        method,
        routeKey,
        requestStartedAt,
        cooldownMs,
        requestJson: geminiRouteRequestJson,
        requestMeta: requestMetaWithSession,
        route: directRoute,
        context: {
          pathname,
          stream: clientProtocol === 'gemini_stream_generate_content'
        },
        deps: {
          chooseServerAccount,
          resolveRequestProvider,
          pushMetricError,
          writeJson,
          fetchWithTimeout,
          fetchModelsForAccount,
          fetchGeminiCodeAssistChatCompletion,
          fetchGeminiCodeAssistChatCompletionStream,
          fetchGeminiCodeAssistGenerateContent,
          fetchGeminiCodeAssistGenerateContentStream,
          fetchCodeAssistAnthropicMessage,
          fetchCodeAssistAnthropicMessageStream,
          fetchOpenCodeChatCompletion,
          fetchOpenCodeChatCompletionStream,
          markProxyAccountFailure,
          markProxyAccountSuccess,
          appendProxyRequestLog,
          refreshCodexAccessToken,
          recordModelUsage,
          handleCodexChatCompletions,
          handleUpstreamPassthrough
        }
      });
      if (isAliasRuntimeFailureResult(routeResult)) return routeResult;
      return true;
    }
    const bridgeRequest = createFallbackProtocolRequest(res, {
      clientProtocol,
      provider,
      payload: geminiRouteRequestJson,
      context: {
        pathname,
        stream: clientProtocol === 'gemini_stream_generate_content'
      }
    });
    if (!bridgeRequest) return true;
    const bridgeResult = await runFallbackProtocolBridge({
      clientProtocol,
      provider,
      options,
      state,
      req: routingReq,
      res,
      method,
      routeKey,
      requestStartedAt,
      cooldownMs,
      requestMeta: requestMetaWithSession,
      bridgeRequest,
      deps: {
        chooseServerAccount,
        resolveRequestProvider,
        pushMetricError,
        writeJson,
        fetchWithTimeout,
        fetchModelsForAccount,
        fetchGeminiCodeAssistChatCompletion,
        fetchGeminiCodeAssistChatCompletionStream,
        fetchGeminiCodeAssistGenerateContent,
        fetchGeminiCodeAssistGenerateContentStream,
        fetchCodeAssistAnthropicMessage,
        fetchCodeAssistAnthropicMessageStream,
        fetchOpenCodeChatCompletion,
        fetchOpenCodeChatCompletionStream,
        markProxyAccountFailure,
        markProxyAccountSuccess,
        appendProxyRequestLog,
        refreshCodexAccessToken,
        recordModelUsage,
        handleCodexChatCompletions,
        handleUpstreamPassthrough
      }
    });
    if (isAliasRuntimeFailureResult(bridgeResult)) return bridgeResult;
    return true;
  }

  if (clientProtocol === 'openai_responses' && options.backend === 'codex-adapter') {
    const responseRequestJson = requestJson || {};
    const provider = requireGatewayProvider(res, {
      options,
      state,
      requestJson: responseRequestJson,
      headers: routingReq && routingReq.headers,
      clientProtocol,
      aliasTargetProvider,
      preferModelRouting,
      aliasResolution
    });
    if (!provider) return true;
    if (provider === 'codex') {
      await handleCodexChatCompletions({
        options,
        state,
        req: routingReq,
        res,
        requestJson: responseRequestJson,
        routeKey,
        requestStartedAt,
        cooldownMs,
        requestMeta: {
          ...requestMetaWithSession,
          clientProtocol: 'openai_responses'
        },
        deps: {
          chooseServerAccount,
          pushMetricError,
          writeJson,
          fetchWithTimeout,
          markProxyAccountFailure,
          markProxyAccountSuccess,
          appendProxyRequestLog,
          refreshCodexAccessToken,
          recordModelUsage
        }
      });
      return true;
    }
    const directRoute = resolveProviderProtocolRouteForClientRequest(clientProtocol, provider, responseRequestJson);
    if (directRoute) {
      const routeResult = await runClientProtocolViaProviderProtocolRoute({
        clientProtocol,
        provider,
        options,
        state,
        req: routingReq,
        res,
        method,
        routeKey,
        requestStartedAt,
        cooldownMs,
        requestJson: responseRequestJson,
        requestMeta: requestMetaWithSession,
        route: directRoute,
        context: { pathname },
        deps: {
          chooseServerAccount,
          resolveRequestProvider,
          pushMetricError,
          writeJson,
          fetchWithTimeout,
          fetchModelsForAccount,
          fetchGeminiCodeAssistChatCompletion,
          fetchGeminiCodeAssistChatCompletionStream,
          fetchGeminiCodeAssistGenerateContent,
          fetchGeminiCodeAssistGenerateContentStream,
          fetchCodeAssistAnthropicMessage,
          fetchCodeAssistAnthropicMessageStream,
          fetchOpenCodeChatCompletion,
          fetchOpenCodeChatCompletionStream,
          markProxyAccountFailure,
          markProxyAccountSuccess,
          appendProxyRequestLog,
          refreshCodexAccessToken,
          recordModelUsage,
          handleCodexChatCompletions,
          handleUpstreamPassthrough
        }
      });
      if (isAliasRuntimeFailureResult(routeResult)) return routeResult;
      return true;
    }
    const bridgeRequest = createFallbackProtocolRequest(res, {
      clientProtocol,
      provider,
      payload: responseRequestJson,
      context: { pathname }
    });
    if (!bridgeRequest) return true;
    const bridgeResult = await runFallbackProtocolBridge({
      clientProtocol,
      provider,
      options,
      state,
      req: routingReq,
      res,
      method,
      routeKey,
      requestStartedAt,
      cooldownMs,
      requestMeta: requestMetaWithSession,
      bridgeRequest,
      deps: {
        chooseServerAccount,
        resolveRequestProvider,
        pushMetricError,
        writeJson,
        fetchWithTimeout,
        fetchModelsForAccount,
        fetchGeminiCodeAssistChatCompletion,
        fetchGeminiCodeAssistChatCompletionStream,
        fetchGeminiCodeAssistGenerateContent,
        fetchGeminiCodeAssistGenerateContentStream,
        fetchCodeAssistAnthropicMessage,
        fetchCodeAssistAnthropicMessageStream,
        fetchOpenCodeChatCompletion,
        fetchOpenCodeChatCompletionStream,
        markProxyAccountFailure,
        markProxyAccountSuccess,
        appendProxyRequestLog,
        refreshCodexAccessToken,
        recordModelUsage,
        handleCodexChatCompletions,
        handleUpstreamPassthrough
      }
    });
    if (isAliasRuntimeFailureResult(bridgeResult)) return bridgeResult;
    return true;
  }

  if (method === 'POST' && pathname === '/v1/chat/completions' && options.backend === 'codex-adapter') {
    const provider = requireGatewayProvider(res, {
      options,
      state,
      requestJson: requestJson || {},
      headers: routingReq && routingReq.headers,
      clientProtocol,
      aliasTargetProvider,
      preferModelRouting,
      aliasResolution
    });
    if (!provider) return true;
    if (provider !== 'codex') {
      const directRoute = resolveProviderProtocolRouteForClientRequest(clientProtocol, provider, requestJson || {});
      if (directRoute) {
        const routeResult = await runClientProtocolViaProviderProtocolRoute({
          clientProtocol,
          provider,
          options,
          state,
          req: routingReq,
          res,
          method,
          routeKey,
          requestStartedAt,
          cooldownMs,
          requestJson: requestJson || {},
          requestMeta: requestMetaWithSession,
          route: directRoute,
          context: { pathname },
          deps: {
            chooseServerAccount,
            resolveRequestProvider,
            pushMetricError,
            writeJson,
            fetchWithTimeout,
            fetchModelsForAccount,
            fetchGeminiCodeAssistChatCompletion,
            fetchGeminiCodeAssistChatCompletionStream,
            fetchGeminiCodeAssistGenerateContent,
            fetchGeminiCodeAssistGenerateContentStream,
            fetchCodeAssistAnthropicMessage,
            fetchCodeAssistAnthropicMessageStream,
            fetchOpenCodeChatCompletion,
            fetchOpenCodeChatCompletionStream,
            markProxyAccountFailure,
            markProxyAccountSuccess,
            appendProxyRequestLog,
            refreshCodexAccessToken,
            recordModelUsage,
            handleCodexChatCompletions,
            handleUpstreamPassthrough
          }
        });
        if (isAliasRuntimeFailureResult(routeResult)) return routeResult;
        return true;
      }
      const passthroughResult = await handleUpstreamPassthrough({
        options,
        state,
        req: routingReq,
        res,
        method,
        bodyBuffer: upstreamBodyBuffer,
        routeKey,
        requestStartedAt,
        cooldownMs,
        requestJson,
        requestMeta: withEffectiveProvider(requestMetaWithSession, provider),
        deps: {
          chooseServerAccount,
          resolveRequestProvider,
          pushMetricError,
          writeJson,
          fetchWithTimeout,
          fetchModelsForAccount,
          fetchGeminiCodeAssistChatCompletion,
          fetchGeminiCodeAssistChatCompletionStream,
          fetchGeminiCodeAssistGenerateContent,
          fetchGeminiCodeAssistGenerateContentStream,
          markProxyAccountFailure,
          markProxyAccountSuccess,
          appendProxyRequestLog,
          refreshCodexAccessToken,
          recordModelUsage
        }
      });
      if (isAliasRuntimeFailureResult(passthroughResult)) return passthroughResult;
      return true;
    }
    await handleCodexChatCompletions({
      options,
      state,
      req: routingReq,
      res,
      requestJson,
      routeKey,
      requestStartedAt,
      cooldownMs,
      requestMeta: requestMetaWithSession,
      deps: {
        chooseServerAccount,
        pushMetricError,
        writeJson,
        fetchWithTimeout,
        markProxyAccountFailure,
        markProxyAccountSuccess,
        appendProxyRequestLog,
        refreshCodexAccessToken,
        recordModelUsage
      }
    });
    return true;
  }

  if (method === 'GET' && pathname === '/v1/models') {
    await handleUpstreamModels({
      options,
      state,
      res,
      deps: {
        buildOpenAIModelsList,
        fetchModelsForAccount,
        FALLBACK_MODELS,
        modelCatalogSettings
      }
    });
    return true;
  }

  const passthroughResult = await handleUpstreamPassthrough({
    options,
    state,
    req: routingReq,
    res,
    method,
    bodyBuffer: upstreamBodyBuffer,
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestJson,
    requestMeta: requestMetaWithSession,
    deps: {
      chooseServerAccount,
      resolveRequestProvider,
      pushMetricError,
      writeJson,
      fetchWithTimeout,
      fetchModelsForAccount,
      fetchGeminiCodeAssistChatCompletion,
      fetchGeminiCodeAssistChatCompletionStream,
      fetchGeminiCodeAssistGenerateContent,
      fetchGeminiCodeAssistGenerateContentStream,
      markProxyAccountFailure,
      markProxyAccountSuccess,
      appendProxyRequestLog,
      refreshCodexAccessToken,
      recordModelUsage
    }
  });
  if (isAliasRuntimeFailureResult(passthroughResult)) return passthroughResult;
  return true;
  };

  if (aliasCandidatesContext.candidates.length < 1) {
    await runResolvedRequest(createResolvedRouteInput(null));
    return true;
  }

  let remainingAliasCandidates = aliasCandidatesContext.candidates.slice();
  const runtimeFailures = [];
  while (remainingAliasCandidates.length > 0) {
    const aliasSelection = await selectAvailableAliasCandidate({
      candidates: remainingAliasCandidates,
      aliases: modelAliasData.aliases,
      state,
      options,
      fetchModelsForAccount
    });
    if (aliasSelection.matched && !aliasSelection.candidate) {
      writeUnavailableAliasSelection(aliasSelection, remainingAliasCandidates, runtimeFailures);
      return true;
    }

    const candidate = aliasSelection.candidate;
    const result = await runResolvedRequest(createResolvedRouteInput(candidate, remainingAliasCandidates, {
      allowModelCooled: Boolean(aliasSelection.lastResort)
    }));
    if (!isAliasRuntimeFailureResult(result)) return true;

    runtimeFailures.push(result);
    remainingAliasCandidates = remainingAliasCandidates.filter((item) => item && item.id !== candidate.id);
    if (res.headersSent || res.writableEnded) return true;
  }

  writeAliasRuntimeFailure(res, writeJson, runtimeFailures[runtimeFailures.length - 1], runtimeFailures.slice(0, -1));
  return true;
}

module.exports = {
  handleV1Request
};
