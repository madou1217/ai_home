'use strict';
const crypto = require('node:crypto');
const { applyGatewayRequestPlugins, currentPluginSnapshot } = require('./gateway-plugin-stage');
const { mergePluginAliases } = require('../plugins/gateway/catalog');
const { writeCodexRelayError } = require('./codex-relay-errors');
const { decodeCodexRequestBody, withoutBodyEncoding } = require('./codex-http-request-body');
const { extractRequestSessionKey, extractRequestProjectMetadata } = require('./session-key');
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
const { deriveAccountRuntimeStatus } = require('./account-runtime-state');
const { deriveEffectiveRuntimeStatus } = require('../account/runtime-view');
const { loadAliases, resolveAliasUpstreamProvider } = require('./model-alias-store');
const { selectPoolAccountsForModel } = require('./model-account-pool-selector');
const { createAnthropicTokenCountResponse } = require('./anthropic-token-count');
const { applyModelNamespaceHeader } = require('./model-namespace-header');
const { applyProviderModelPrefix } = require('./provider-model-prefix');
const { isOpenCodeNativeClient } = require('./opencode-native-client');
const {
  normalizeModelCatalogSettings,
  loadModelCatalogSettings
} = require('./model-catalog-settings-store');
const {
  applyAliasCandidate,
  resolveModelAliasCandidates
} = require('./model-alias-resolver');
const { resolveGatewayProvider } = require('./capability-router');
const { listCrossProviderFallbacks } = require('./cross-provider-fallback');
const { runWithTrace } = require('./request-trace');
const {
  buildGatewayModelEntries,
  mergeGatewayModelEntries
} = require('./gateway-model-list');
const { resolveProviderProtocolRouteForClientRequest } = require('./provider-protocol-routing');
const { exceedsCodexRelayHopLimit } = require('./codex-relay-hop');
const { shouldRouteCodexViaChatCompletions } = require('./codex-wire-routing');
const {
  buildModelAccountIndex,
  findRoutableAccountsForModel
} = require('./model-account-index');
const {
  buildModelCapabilityIndex,
  modelHasCatalogProvider,
  modelHasRoutableProvider,
  modelHasAvailableProvider,
  summarizeModelProviderCooldown
} = require('./model-capability-index');
const { buildModelDiscoverySignature } = require('./provider-model-discovery');
const { validateAliasTarget } = require('./model-alias-validation');
const { aliasTargetCatalogIsUnknown } = require('./model-catalog-knowledge');
const { refreshStaleAgyUsageSnapshotsForPool } = require('./agy-usage-snapshot');
const { modelMatchesCapability } = require('./model-modality-index');
const {
  buildCatalogVisibility,
  filterOpenAIModelsBodyByCatalogVisibility,
  buildModelAccountEvidence,
  addByAccountEvidence,
  modelEvidenceLookupKeys
} = require('./model-catalog-visibility');
const { getImageBlob } = require('./image-blob-store');
const {
  isImageMultipartContentType,
  parseImageMultipartRequest
} = require('./image-generation-multipart');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { isAccountRef } = require('./account-ref-store');
const {
  isPinUsable,
  resolvePinnedAccount,
  readPinnedAccountRef
} = require('./pinned-account');
const { readRetiredAccountRef } = require('../account/retired-account-refs');
const { tryFabricGatewayRoute } = require('./fabric-gateway-route');
const { orderModelRouteSources } = require('./model-route-source-scheduler');
const { recordModelUsageRequestContext } = require('./model-usage-request-context');
const { rejectNonPostInference } = require('./v1-method-guard');
const {
  readPersistedGatewayModelCache,
  writePersistedGatewayModelCache
} = require('./gateway-model-cache');

const IMAGE_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

function isImageRequestPathname(pathname) {
  return pathname === '/v1/images/edits' || pathname === '/v1/images/generations';
}

function resolveRequestBodyLimit(pathname, maxRequestBodyBytes) {
  const configured = Math.max(1024, Number(maxRequestBodyBytes) || 0);
  if (isImageRequestPathname(pathname)) {
    return Math.max(configured, IMAGE_REQUEST_BODY_BYTES);
  }
  return configured;
}

function writeImageRequestError(res, writeJson, error) {
  const status = Number(error && error.statusCode) || 400;
  const code = String(error && error.code || 'invalid_multipart_body').trim();
  const message = String(error && (error.detail || error.message) || 'image request body is invalid').trim();
  writeJson(res, status, {
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code
    }
  });
}

function rewriteRequestUrlPathname(req, pathname) {
  if (!req || typeof req !== 'object') return req;
  const originalUrl = String(req.url || '');
  const safePathname = String(pathname || '').trim() || '/';
  const queryIndex = originalUrl.indexOf('?');
  const query = queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';
  return {
    ...req,
    url: `${safePathname}${query}`,
    headers: req && req.headers || {}
  };
}

// 摘掉钉选头:钉选失效回落常池时用——下游(codex-adapter、WS relay)会按
// x-account-ref 再过滤一次池,不摘的话回落会被死钉二次截杀成 no_available_account。
function stripPinnedAccountRefHeaders(req) {
  const headers = { ...(req && req.headers || {}) };
  delete headers['x-account-ref'];
  delete headers['X-Account-Ref'];
  return { ...req, headers };
}

// 显式选择某个 provider（现有的 x-provider 通道，capability-router 的
// resolveExplicitProvider 与 provider-routing 都读它）。钉选账号与模型命名空间前缀都走这一条，
// 因此不会在选号层留下两套“这个请求归谁”的判定。
function withExplicitProvider(req, provider) {
  return {
    ...req,
    headers: {
      ...(req && req.headers || {}),
      'x-provider': provider
    }
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

function isCodexNativeModelsRequest(req) {
  try {
    const parsed = new URL(String(req && req.url || ''), 'http://aih.local');
    return parsed.searchParams.has('client_version');
  } catch (_error) {
    return false;
  }
}

// `?capability=vision|image_out` filter for GET /v1/models. Parsed from the
// raw request url (pathname matching elsewhere ignores the query string).
function parseModelsCapabilityParam(url) {
  const raw = String(url || '');
  const queryIndex = raw.indexOf('?');
  if (queryIndex < 0) return '';
  let params;
  try {
    params = new URLSearchParams(raw.slice(queryIndex + 1));
  } catch (_error) {
    return '';
  }
  return String(params.get('capability') || '').trim().toLowerCase();
}

// Filters an OpenAI models list body by capability. Applied after any cache
// read so cached bodies always stay unfiltered (one cache entry serves every
// capability query). Non-JSON / non-list bodies pass through untouched.
function filterOpenAIModelsBodyByCapability(bodyText, capability) {
  if (!capability) return bodyText;
  let payload;
  try {
    payload = JSON.parse(String(bodyText || ''));
  } catch (_error) {
    return bodyText;
  }
  if (!payload || !Array.isArray(payload.data)) return bodyText;
  payload.data = payload.data.filter((item) => {
    const modalities = item && item.aih_modalities;
    const normalizedCapability = String(capability || '').trim().toLowerCase();
    if (modalities && Array.isArray(modalities.input) && Array.isArray(modalities.output)) {
      if (normalizedCapability === 'vision') return modalities.input.includes('image');
      if (normalizedCapability === 'image_out') return modalities.output.includes('image');
      return true;
    }
    return modelMatchesCapability(item && item.id, normalizedCapability);
  });
  return JSON.stringify(payload);
}

// Runs a models handler that writes directly to `res`. Without a capability
// filter the handler keeps its zero-copy path; with one, the response is
// captured in memory, filtered, then replayed (headers minus content-length,
// which no longer matches the filtered body).
async function runModelsHandlerWithCapabilityFilter(res, capability, run) {
  if (!capability) {
    await run(res);
    return;
  }
  const memoryRes = createMemoryResponse();
  await run(memoryRes);
  res.statusCode = Number(memoryRes.statusCode || 200);
  Object.entries(memoryRes.headers || {}).forEach(([key, value]) => {
    if (String(key).toLowerCase() === 'content-length') return;
    res.setHeader(key, value);
  });
  const body = res.statusCode >= 200 && res.statusCode < 300
    ? filterOpenAIModelsBodyByCapability(memoryRes.body, capability)
    : memoryRes.body;
  res.end(body);
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

/**
 * 直连请求在所有候选 provider 都失败后写出最终错误。
 *
 * 与 writeAliasRuntimeFailure 的区别：这里没有别名，所以不写 `alias` 字段；改在 `tried`
 * 里如实列出「试过哪些 provider」，让排障一眼看到换号换到了哪里 —— 用户抱怨的正是
 * 「遇到问题看不出 gateway 做了什么，和手动切换没区别」。
 */
function writeCrossProviderFailure(res, writeJson, failures) {
  const list = (Array.isArray(failures) ? failures : []).filter(Boolean);
  const last = list[list.length - 1] || {};
  const tried = list.map((item) => ({
    provider: String(item && item.provider || '').trim(),
    statusCode: Number(item && item.statusCode || 0) || undefined,
    error: String(item && item.error || '').trim() || undefined
  }));
  writeJson(res, Number(last.statusCode || 502), {
    ok: false,
    error: String(last.error || 'upstream_failed'),
    detail: String(last.detail || 'upstream request failed'),
    // 只在真的换过 provider 时才带这个字段（单 provider 失败的形状保持不变）。
    ...(tried.length > 1 ? { tried } : {})
  });
}

function requireGatewayProvider(res, input) {  const result = resolveGatewayProvider(input);
  if (result && result.provider) return result.provider;
  writeGatewayProviderUnavailable(res, result, input && input.clientProtocol, input && input.aliasResolution);
  return '';
}

function resolveNativeRouteFallback(input = {}) {
  const aliasCandidates = Array.isArray(input.aliasCandidates) ? input.aliasCandidates : [];
  if (aliasCandidates.length === 0) return null;
  const requestJson = input.requestJson && typeof input.requestJson === 'object'
    ? input.requestJson
    : {};
  const model = String(requestJson.model || '').trim();
  if (!model) return null;
  const resolution = resolveGatewayProvider({
    options: input.options || {},
    state: input.state || {},
    requestJson,
    headers: input.headers || {},
    clientProtocol: input.clientProtocol || ''
  });
  const provider = String(resolution && resolution.provider || '').trim();
  if (!provider) return null;

  // Alias targets and the originally requested model are different route
  // sources even when they share a Provider. Only synthesize the native source
  // when a real account catalog says that Provider can serve the requested
  // model; model-family inference alone must never leak an alias name/target to
  // an incompatible native endpoint.
  const modelCapabilityIndex = buildModelCapabilityIndex(
    input.state || {},
    input.options || {}
  );
  if (!modelHasAvailableProvider(modelCapabilityIndex, model, provider)) {
    return null;
  }

  // An alias that resolves to the same concrete provider/model is already the
  // native route. Repeating it would spend the same account pool twice without
  // adding a fallback candidate.
  const duplicated = aliasCandidates.some((candidate) => (
    String(candidate && candidate.target || '').trim() === model
    && String(candidate && candidate.targetProvider || '').trim() === provider
  ));
  if (duplicated) return null;
  return { provider, model };
}

// 按优先级顺序逐个校验别名候选的 target 是否在真实目录中有可用账号,选中第一个可用候选。
// 全部失败时强刷一次模型缓存再整轮重试;仍失败则返回已尝试列表用于 502 详情。
async function selectAvailableAliasCandidate(input = {}) {
  const {
    candidates,
    aliases,
    state,
    options
  } = input;
  const orderedCandidates = Array.isArray(candidates) ? candidates : [];
  if (orderedCandidates.length === 0) {
    return { matched: false, candidate: null, tried: [] };
  }

  // 优先用倒排索引（model→account），O(1) 查哪个别名目标有可用账号。
  // 索引从持久化缓存构建，重启立即可用。
  const modelIndex = state && state.modelAccountIndex && state.modelAccountIndex.builtAt > 0
    ? state.modelAccountIndex
    : buildModelAccountIndex(state || {}, options || {});
  const indexWarm = modelIndex.accountToModels.size > 0;

  const accountCatalogIsUnknown = (candidate) => {
    const targetProvider = String(candidate && candidate.targetProvider || '').trim().toLowerCase();
    for (const [accountRef, account] of modelIndex.accountByRef.entries()) {
      if (targetProvider && targetProvider !== 'auto' && account.provider !== targetProvider) continue;
      if (!modelIndex.accountToModels.has(accountRef)) return true;
    }
    return false;
  };

  const tryAllCandidates = () => {
    var tried = [];
    var lastResortCandidate = null;
    var unknownCandidate = null;

    // 倒排索引可用：按候选优先级遍历，查到第一个有可用账号的目标就返回。
    // 某个相关账号尚无目录时保留冷缓存语义，先尝试该候选，不把“未知”误判成“不支持”。
    if (indexWarm) {
      for (var i = 0; i < orderedCandidates.length; i++) {
        var candidate = orderedCandidates[i];
        var targetProvider = String(candidate.targetProvider || '').trim().toLowerCase();
        var accountRefs = findRoutableAccountsForModel(
          modelIndex,
          candidate.target,
          targetProvider === 'auto' ? '' : targetProvider
        );
        if (accountRefs.length > 0) {
          return { candidate: candidate, tried: tried, lastResortCandidate: null };
        }
        if (!unknownCandidate && accountCatalogIsUnknown(candidate)) {
          unknownCandidate = candidate;
        }
      }
    }

    // 完全冷启动时没有目录事实可用于否定 alias，直接尝试最高优先级候选。
    if (!indexWarm) {
      if (orderedCandidates.length > 0) {
        return { candidate: orderedCandidates[0], tried: tried, lastResortCandidate: null };
      }
      return { candidate: null, tried: tried, lastResortCandidate: null };
    }
    const modelCapabilityIndex = buildModelCapabilityIndex(state || {}, options || {});
    const now = Date.now();
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
        const providers = Array.isArray(result.providers) && result.providers.length > 0
          ? result.providers
          : [candidate.targetProvider].filter(Boolean);
        const routable = providers.some((provider) => modelHasRoutableProvider(modelCapabilityIndex, candidate.target, provider, now));
        if (routable) return { candidate, tried, lastResortCandidate: null };
        if (!lastResortCandidate) {
          const lastResortOk = providers.some((provider) => modelHasAvailableProvider(modelCapabilityIndex, candidate.target, provider, now));
          if (lastResortOk) lastResortCandidate = candidate;
        }
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
      // 「不在目录里」必须是事实，不能是无知。模型目录被失效/尚未扫描时（例如账号运行态
      // 事件刚清过缓存），能力索引是空的，validateAliasTarget 会把每个目标都判成
      // not_in_catalog。此时沿用冷启动语义：把候选记为「未知」，宁可发一次真实请求，
      // 也不要凭空否定一个正常的别名目标。
      if (
        result.error === 'alias_target_model_not_in_catalog'
        && aliasTargetCatalogIsUnknown(modelCapabilityIndex, state, result.providers)
      ) {
        if (!unknownCandidate) unknownCandidate = candidate;
        continue;
      }
      tried.push(buildTriedAliasCandidate(candidate, result));
    }
    if (!lastResortCandidate && unknownCandidate) {
      return { candidate: unknownCandidate, tried, lastResortCandidate: null };
    }
    return { candidate: null, tried, lastResortCandidate };
  };

  const attempt = tryAllCandidates();
  if (attempt.candidate) {
    return { matched: true, candidate: attempt.candidate, tried: attempt.tried };
  }
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

async function readUserModelAliases(state, deps = {}) {
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

// 有效别名 = 用户别名 + 当前插件代次声明的别名（用户别名与真实模型 ID 优先）。列表与请求路由都只经这里读，
// 保证两者看到同一份目录；state.modelAliases 仍只存用户别名。
async function readModelAliases(state, deps = {}, options = {}) {
  const data = await readUserModelAliases(state, deps);
  const snapshot = currentPluginSnapshot(state);
  if (!snapshot || !snapshot.catalogAliases.length) return data;
  const index = buildModelCapabilityIndex(state || {}, options || {});
  const isRealModel = (id) => SUPPORTED_SERVER_PROVIDERS.some((provider) => modelHasCatalogProvider(index, id, provider));
  return { ...data, aliases: mergePluginAliases(data && data.aliases, snapshot, { isRealModel }) };
}

// /v1/models 缓存签名里的别名版本：别名表一变（含通配别名展开规则升级），旧列表立即作废，
// 不必等 TTL。只取影响列表的字段，hash 成短串避免签名随别名数增长。
const ALIAS_CATALOG_LIST_VERSION = 'wildcard-expansion-v1';
function aliasCatalogRevision(aliases) {
  const shape = (Array.isArray(aliases) ? aliases : []).map((item) => [
    item && item.alias, item && item.target, item && item.provider, item && item.targetProvider, item && item.enabled !== false
  ]);
  return crypto.createHash('sha1').update(`${ALIAS_CATALOG_LIST_VERSION}|${JSON.stringify(shape)}`).digest('hex').slice(0, 12);
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

// buildModelCatalogProjection strips cache timestamps and preserves only the
// low-sensitivity public model contract. The revision hashes the exact sorted
// projection so Node can skip idempotent Go management PUTs.
function buildModelCatalogProjection(mergedList, buildOpenAIModelsList) {
  const body = buildOpenAIModelsList(mergedList);
  const models = (Array.isArray(body && body.data) ? body.data : [])
    .map((item) => ({
      id: String(item && item.id || ''),
      owned_by: String(item && item.owned_by || 'aih-server'),
      input_modalities: Array.isArray(item && item.aih_modalities && item.aih_modalities.input)
        ? item.aih_modalities.input.map((value) => String(value))
        : ['text'],
      output_modalities: Array.isArray(item && item.aih_modalities && item.aih_modalities.output)
        ? item.aih_modalities.output.map((value) => String(value))
        : ['text'],
      reasoning_efforts: Array.isArray(item && item.aih_reasoning_efforts)
        ? item.aih_reasoning_efforts.map((value) => String(value))
        : []
    }))
    .filter((item) => item.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  const canonical = JSON.stringify(models);
  return {
    revision: crypto.createHash('sha256').update(canonical).digest('hex'),
    models
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
  const responsesRequest = method === 'POST' && pathname === '/v1/responses';
  let routingReq = pathname === rawPathname ? req : rewriteRequestUrlPathname(req, pathname);

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
    handleImageGenerations,
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
    refreshClaudeAccessToken,
    refreshAgyAccessToken,
    refreshGrokAccessToken,
    refreshKimiAccessToken,
    recordModelUsage,
    accountActivity,
    proxyFabricGatewayRequest,
    fabricBrokerSessionRegistry,
    accountStateIndex,
    fs,
    aiHomeDir,
    providerSessionStateStore,
    pushModelCatalogProjection
  } = deps;

  if (!pathname.startsWith('/v1/') && !pathname.startsWith('/v1beta/')) return false;

  if (requiredClientKey) {
    const incoming = parseV1ClientKey(req.headers, parseAuthorizationBearer);
    if (incoming !== requiredClientKey) {
      if (responsesRequest) writeCodexRelayError(res, 'unauthorized');
      else writeJson(res, 401, { ok: false, error: 'unauthorized_client' });
      return true;
    }
  }

  // 跳数上限（不是「有头即拒」）：跨机中转（本机网关 → 远程 server 网关）是正常拓扑，
  // 只有超过上限才说明出现了 A→B→A 的环。见 codex-relay-hop.js。
  if (responsesRequest && exceedsCodexRelayHopLimit(req.headers)) {
    writeCodexRelayError(res, 'infinite_loop_detected');
    return true;
  }

  if (rejectNonPostInference({ method, pathname, res, writeJson })) return true;

  const pinnedAccountRef = readPinnedAccountRef(routingReq && routingReq.headers);
  let pinnedAccount = null;
  if (pinnedAccountRef) {
    if (!isAccountRef(pinnedAccountRef)) {
      if (responsesRequest) writeCodexRelayError(res, 'invalid_account_ref');
      else writeJson(res, 400, { ok: false, error: 'invalid_account_ref' });
      return true;
    }
    // 同身份重新登录需在运行态检查前吸收；停用/删除账号仍由恢复服务的生命周期检查拦下。
    let pin = resolvePinnedAccount(state, accountStateIndex, pinnedAccountRef);
    if (pin.resolvedPin?.provider === 'claude' && typeof deps.recoverClaudeLogin === 'function') {
      deps.recoverClaudeLogin(pin.resolvedPin.account);
      pin = resolvePinnedAccount(state, accountStateIndex, pinnedAccountRef);
    }
    const { resolvedPin, persistedPin, usable: pinUsable } = pin;
    if (pinUsable) {
      pinnedAccount = resolvedPin;
      routingReq = withExplicitProvider(routingReq, pinnedAccount.provider);
    } else {
      // 钉选是亲和偏好,不是死刑。钉住的账号被停用/删除/失效时:只要同 provider 池里
      // 还有别的可调度账号,就摘掉钉头回落常池,而不是把会话钉死在死账号上(此前
      // 403/404,明明有两个健康账号也照样拒服)。安全性质不变——常池选择经
      // chooseServerAccount 的持久化同步,死账号永远不会被选中、陈旧凭据不会出站。
      // 真的一个可调度账号都没有时,才报精确的死钉错误(403/404,可执行的 hint)。
      // 边界:只对「认识」的钉(持久化层有生命周期行:停用/删除都留有行)回落;
      // 持久化层与运行池都没有的 ref 是「从未存在」,必须 404,不得静默借用
      // 别的账号身份(test/server.kimi-responses.test.js 契约)。
      // 已删除账号的持久化行全被清掉,靠退役记录认出「曾经存在」——同样按停用处理回落,
      // 而不是当成从未存在的 ref 抛 404 给正在跑的会话。
      const retiredPin = persistedPin ? null : readRetiredAccountRef(deps.fs, deps.aiHomeDir, pinnedAccountRef);
      const knownPin = persistedPin || retiredPin;
      const fallbackProvider = (resolvedPin && resolvedPin.provider)
        || (knownPin && knownPin.provider)
        || '';
      const candidatePools = fallbackProvider ? [fallbackProvider] : SUPPORTED_SERVER_PROVIDERS;
      const hasSchedulableAlternative = Boolean(knownPin) && candidatePools.some((provider) => {
        const pool = state.accounts && Array.isArray(state.accounts[provider]) ? state.accounts[provider] : [];
        return pool.some((candidate) => {
          const ref = String(candidate && candidate.accountRef || '').trim();
          if (!ref || ref === pinnedAccountRef) return false;
          const row = accountStateIndex && typeof accountStateIndex.getAccountState === 'function'
            ? accountStateIndex.getAccountState(ref) : null;
          return isPinUsable(candidate, accountStateIndex, row);
        });
      });
      if (hasSchedulableAlternative) {
        if (fallbackProvider) {
          routingReq = withExplicitProvider(routingReq, fallbackProvider);
        }
        // 关键:摘掉死钉头——codex-adapter 等下游会按 x-account-ref 再过滤一次池,
        // 不摘的话回落会被死钉二次截杀成 no_available_account。
        routingReq = stripPinnedAccountRefHeaders(routingReq);
        if (state && state.metrics) {
          pushMetricError(state.metrics, pathname, fallbackProvider || 'unknown', {
            message: 'pinned_account_fallback',
            pinnedAccountRef,
            detail: `pinned account not schedulable (status=${retiredPin ? 'deleted' : String(persistedPin.status || 'unknown')}, runtime=${deriveEffectiveRuntimeStatus(resolvedPin?.account, persistedPin).status}), fell back to pool`
          });
        }
      } else if (knownPin) {
        const pinStatus = retiredPin ? 'deleted' : String(persistedPin.status || '');
        const pinRuntimeStatus = retiredPin ? ''
          : deriveEffectiveRuntimeStatus(resolvedPin?.account, persistedPin).status;
        if (pinStatus === 'up' && pinRuntimeStatus === 'auth_invalid') {
          writeJson(res, 401, {
            ok: false,
            error: 'auth_invalid_reauth_required',
            accountRef: pinnedAccountRef,
            provider: fallbackProvider || undefined,
            reason: pinRuntimeStatus,
            hint: '该账号登录态已失效,请重新登录后再用它发起请求'
          });
          return true;
        }
        writeJson(res, 403, {
          ok: false,
          error: 'pinned_account_unavailable',
          accountRef: pinnedAccountRef,
          provider: fallbackProvider || undefined,
          status: pinStatus,
          // runtimeState 可能仍是 healthy(凭据没问题),不可调度来自账号生命周期被停用。
          // 报 healthy 会让人以为账号好着——取真正解释「为什么不可用」的那个。
          reason: pinRuntimeStatus && pinRuntimeStatus !== 'healthy'
            ? pinRuntimeStatus
            : `account_${pinStatus || 'not_schedulable'}`,
          hint: pinRuntimeStatus === 'billing_blocked'
            ? '该账号余额不足或账单受限，充值或解除限制后请手动恢复调度'
            : pinRuntimeStatus === 'quota_exhausted'
            ? '该账号额度已耗尽，请重置额度或等待恢复并刷新用量'
            : pinRuntimeStatus === 'permission_denied'
            ? '该账号权限受限，解除限制后请手动恢复调度'
            : pinRuntimeStatus === 'auth_invalid'
            ? '该账号登录态已失效,请重新登录后再用它发起请求'
            : '该账号已停用或被删除;本会话绑定的就是它,请重新启用该账号,或改用其它账号新建会话'
        });
        return true;
      } else {
        // 运行池与持久化层都没有这条记录,且全池无可调度账号,才是「未知」。
        writeJson(res, 404, { ok: false, error: 'unknown_account_ref' });
        return true;
      }
    }
  }

  const bodyBufferResult = await readRequestBody(req, {
    maxBytes: resolveRequestBodyLimit(pathname, maxRequestBodyBytes)
  }).catch((error) => ({ __error: error }));
  if (!bodyBufferResult || bodyBufferResult.__error) {
    const err = bodyBufferResult && bodyBufferResult.__error;
    if (err && ['request_body_too_large', 'request_body_buffer_budget_exhausted'].includes(err.code)) {
      writeJson(res, 413, { ok: false, error: 'request_body_too_large' });
      return true;
    }
    if (responsesRequest) writeCodexRelayError(res, 'invalid_request_body');
    else writeJson(res, 400, { ok: false, error: 'invalid_request_body' });
    return true;
  }
  let bodyBuffer = bodyBufferResult;
  if (responsesRequest) {
    try {
      bodyBuffer = decodeCodexRequestBody(bodyBuffer, req.headers, maxRequestBodyBytes);
      if (req.headers['content-encoding']) routingReq = withoutBodyEncoding(routingReq);
    } catch (_) {
      writeCodexRelayError(res, 'invalid_request_body');
      return true;
    }
  }

  const contentType = readHeaderValue(req && req.headers, 'content-type');
  const multipartImageRequest = method === 'POST'
    && isImageRequestPathname(pathname)
    && isImageMultipartContentType(contentType);
  let requestJson = null;
  if (multipartImageRequest) {
    try {
      requestJson = await parseImageMultipartRequest(bodyBuffer, contentType);
    } catch (error) {
      writeImageRequestError(res, writeJson, error);
      return true;
    }
  } else {
    try {
      requestJson = bodyBuffer.length > 0 ? JSON.parse(bodyBuffer.toString('utf8')) : {};
    } catch (_error) {
      if (responsesRequest) {
        writeCodexRelayError(res, 'invalid_request_body');
        return true;
      }
      requestJson = {};
    }
  }
  console.log(`[aih] Incoming request: ${method} ${pathname}, model requested: ${requestJson && requestJson.model || 'none'}`);
  let upstreamBodyBuffer = bodyBuffer;
  if (!multipartImageRequest && requestJson && typeof requestJson === 'object' && bodyBuffer.length > 0) {
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
  // 显式命名空间头（见 model-namespace-header）：必须在别名、provider 解析与选号之前补全。
  if (!multipartImageRequest) {
    const namespaced = applyModelNamespaceHeader(req.headers, requestJson);
    if (namespaced) {
      requestJson = namespaced;
      upstreamBodyBuffer = Buffer.from(JSON.stringify(namespaced));
    }
  }

  // 真实 opencode 客户端的请求本来就满足免费档门禁，下游原样转发（见 opencode-native-client）。
  if (requestMeta && isOpenCodeNativeClient(req.headers)) requestMeta.openCodeNativeClient = true;

  const clientProtocol = detectClientProtocol(method, pathname);
  if (options.logRequests) {
    recordModelUsageRequestContext(appendProxyRequestLog, {
      requestMeta,
      requestJson,
      model: extractGeminiModelFromPath(pathname),
      clientProtocol,
      method,
      pathname
    });
  }
  if (clientProtocol === 'anthropic_count_tokens') {
    const routeKey = `${method} ${pathname}`;
    incrementRouteMetrics(state, routeKey);
    if (state && state.metrics) {
      state.metrics.totalSuccess = Number(state.metrics.totalSuccess || 0) + 1;
    }
    writeLocalJson(res, 200, createAnthropicTokenCountResponse(requestJson || {}));
    return true;
  }

  // 插件 gateway.request：在 Fabric、别名与账号选择之前变换或拒绝请求（没有插件时立即返回）。
  if (!multipartImageRequest) {
    const pluginStage = await applyGatewayRequestPlugins({ state, res, pathname, clientProtocol, requestJson, writeJson, requestMeta });
    if (pluginStage.handled) return true;
    if (pluginStage.requestJson) {
      requestJson = pluginStage.requestJson;
      upstreamBodyBuffer = pluginStage.bodyBuffer;
    }
  }

  if (!pinnedAccount && await tryFabricGatewayRoute({
      req: routingReq,
      res,
      method,
      pathname,
      options,
      state,
      bodyBuffer: upstreamBodyBuffer,
      requestJson,
      model: String(
        requestJson && requestJson.model
        || extractGeminiModelFromPath(pathname)
        || ''
      )
    }, {
      writeJson,
      proxyFabricGatewayRequest,
      fabricBrokerSessionRegistry,
      incrementRouteMetrics,
      pushMetricError
    })) return true;

  const modelAliasData = await readModelAliases(state, deps, options);
  const modelCatalogSettings = await readModelCatalogSettings(state, deps);
  // A re-login must be reconciled before availability/model filtering, which
  // can reject the request without ever invoking the normal account selector.
  // Client authentication and the pinned account lifecycle check ran above.
  if (typeof deps.recoverClaudeLogin === 'function') {
    const loginRecoveryPool = pinnedAccount ? [pinnedAccount.account] : state.accounts && state.accounts.claude;
    for (const account of loginRecoveryPool || []) deps.recoverClaudeLogin(account);
  }
  const aliasCandidatesContext = resolveModelAliasCandidates({
    // An account-pinned request is the CLI equivalent of direct account use.
    // Rewriting its model through a global alias could switch providers and
    // defeat the pin, so pinned requests keep the model exactly as requested.
    aliases: pinnedAccount ? [] : modelAliasData.aliases,
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
    // 与 upstream-endpoints 同理：整池用量刷新是后台观测，不能进入首字节延迟。
    void refreshStaleAgyUsageSnapshotsForPool({
      pool: state.accounts.agy,
      options,
      fs: deps.fs,
      aiHomeDir: deps.aiHomeDir || options.aiHomeDir,
      fetchWithTimeout
    }).catch(() => null);
  }
  // 模型命名空间前缀（`provider/model`）：只在 provider 描述符**显式声明**
  // `providerModelPrefix` 时生效（见 lib/server/provider-model-prefix.js）。这里把它还原成裸 id
  // 并把 provider 钉死：裸 id 常被多家同时持有（实测 glm-5.3 同时在 zcode /
  // codebuddy / workbuddy / workbuddycn），不钉会让请求漂到别家的池子。
  // 必须在别名之后，且别名已命中时整体跳过：别名是用户显式配的名字，它拥有该名字的最高
  // 解释权（包括它自己的 target_provider）；在这里追加前缀解析会与别名的 provider 钉选打架。
  if (!multipartImageRequest && aliasCandidatesContext.candidates.length === 0) {
    const prefixed = applyProviderModelPrefix({
      requestJson,
      headers: routingReq && routingReq.headers,
      options,
      state
    });
    if (prefixed) {
      requestJson = prefixed.requestJson;
      upstreamBodyBuffer = Buffer.from(JSON.stringify(prefixed.requestJson));
      // provider 钉死走现有的显式选择通道（x-provider），不新增派发分支。
      routingReq = withExplicitProvider(routingReq, prefixed.provider);
    }
  }
  const originalRequestJson = requestJson;
  const originalUpstreamBodyBuffer = upstreamBodyBuffer;
  const aliasRouteCandidates = aliasCandidatesContext.candidates;
  const nativeRouteFallback = resolveNativeRouteFallback({
    aliasCandidates: aliasRouteCandidates,
    requestJson: originalRequestJson,
    clientProtocol,
    options,
    state,
    headers: routingReq && routingReq.headers
  });
  const createResolvedRouteInput = (candidate, routeOptions = {}) => {
    const aliasContext = applyAliasCandidate({
      requestJson: originalRequestJson,
      candidate,
      baseProvider: aliasCandidatesContext.baseProvider
    });
    const nextBodyBuffer = aliasContext.changed
      ? Buffer.from(JSON.stringify(aliasContext.requestJson))
      : originalUpstreamBodyBuffer;
    return {
      requestJson: aliasContext.requestJson,
      upstreamBodyBuffer: nextBodyBuffer,
      aliasResolution: aliasContext.aliasResolution,
      aliasTargetProvider: aliasContext.aliasTargetProvider,
      preferModelRouting: aliasContext.preferModelRouting,
      allowModelCooled: Boolean(routeOptions && routeOptions.allowModelCooled),
      // 别名命中即开启「运行时失败交还」：命中之后失败的不是普通请求，而是「某个别名目标
      // 打不通」，这个结论必须以别名形态回给调用方（alias + triedAliasTargets），否则只剩
      // 一个裸 502，排障时看不出是哪个别名、哪个目标、试过谁。
      //
      // 此前还要求「还有下一个候选，或请求模型在原生 provider 目录里有可用账号」才开，于是
      // **单目标别名**（例如 claude-* → 某一个具体模型）在唯一目标失败时既没有回落、也拿不到
      // 别名上下文（2026-10-26 实测：5.0s 后直接裸 502）。没有可回落的目标时，这条开关只是把
      // 失败说得更清楚，不会多打一次上游。
      aliasRuntimeFallback: (
        aliasContext.changed || Boolean(routeOptions && routeOptions.runtimeFallback)
      )
        ? {
            enabled: true,
            candidateId: String(candidate && candidate.id || ''),
            requestedModel: String(aliasContext.aliasResolution.requestedModel || ''),
            target: String(candidate && candidate.target || ''),
            provider: String(aliasContext.aliasTargetProvider || candidate && candidate.targetProvider || ''),
            model: String(aliasContext.requestJson && aliasContext.requestJson.model || '')
          }
        : null
    };
  };

  /**
   * 直连请求的跨 provider 回落：模型名不变，只把 provider 换成另一个持有它的。
   *
   * 复用 createResolvedRouteInput 的产物（它已带好 aliasRuntimeFallback 开关与请求体），
   * 只覆盖 provider 相关的字段：
   * - `aliasTargetProvider` → requestMeta.effectiveProvider → upstream-endpoints 用它覆盖
   *   provider 解析（见 upstream-endpoints.js 的 effectiveProvider 分支）；
   * - `preferModelRouting: false` → 让解析走这个显式 provider，而不是再按模型名猜一次
   *   （否则会原样选回刚才失败的那个）。
   */
  const createCrossProviderRouteInput = (fallback) => {
    const provider = String(fallback && fallback.provider || '').trim();
    const base = createResolvedRouteInput(null);
    if (!provider) return base;
    return {
      ...base,
      aliasTargetProvider: provider,
      preferModelRouting: false,
      aliasRuntimeFallback: {
        ...(base.aliasRuntimeFallback || {}),
        enabled: true,
        provider,
        model: String(originalRequestJson && originalRequestJson.model || '')
      }
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
  const { projectPath, projectDirName } = extractRequestProjectMetadata(routingReq.headers || {}, requestJson || {});
  const requestedModel = String((requestJson && requestJson.model) || (aliasResolution && aliasResolution.effectiveModel) || '').trim();
  const requestMetaWithSession = {
    ...(requestMeta || {}),
    sessionKey,
    sessionId: sessionKey,
    projectPath,
    projectDirName,
    model: requestedModel,
    aliasResolution,
    ...(pinnedAccount ? { accountRef: pinnedAccountRef } : {}),
    ...(aliasTargetProvider ? { effectiveProvider: aliasTargetProvider } : {}),
    ...(aliasRuntimeFallback ? { aliasRuntimeFallback } : {}),
    ...(allowModelCooled ? { allowModelCooled: true } : {})
  };
  countRequestOnce(routeKey);

  const modelsCapabilityFilter = method === 'GET'
    ? parseModelsCapabilityParam(routingReq && routingReq.url)
    : '';

  if (method === 'GET' && pathname === '/v1/models' && options.backend === 'codex-adapter') {
    if (isCodexNativeModelsRequest(routingReq)) {
      await handleCodexModels({
        options,
        state,
        res,
        responseFormat: 'codex',
        deps: {
          buildOpenAIModelsList,
          fetchWithTimeout,
          modelCatalogSettings
        }
      });
      return true;
    }
    const providerMode = String((options && options.provider) || 'auto').trim().toLowerCase();
    if (providerMode === 'codex') {
      await runModelsHandlerWithCapabilityFilter(res, modelsCapabilityFilter, (targetRes) => handleCodexModels({
        options,
        state,
        res: targetRes,
        deps: {
          buildOpenAIModelsList,
          fetchWithTimeout,
          modelCatalogSettings
        }
      }));
      return true;
    }
    if (SUPPORTED_SERVER_PROVIDERS.includes(providerMode)) {
      await runModelsHandlerWithCapabilityFilter(res, modelsCapabilityFilter, (targetRes) => handleUpstreamModels({
        options: { ...options, provider: providerMode },
        state,
        res: targetRes,
        deps: {
          buildOpenAIModelsList,
          fetchModelsForAccount,
          FALLBACK_MODELS,
          modelCatalogSettings
        }
      }));
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
    const currentCodexClientVersion = typeof options.currentCodexClientVersion === 'function'
      ? options.currentCodexClientVersion()
      : options.codexClientVersion;
    const globalModelsSignature = `auto|${buildModelDiscoverySignature(state, {
      providerMode: 'auto',
      includeCodex: true,
      codexClientVersion: currentCodexClientVersion
    })}|limit=${globalCandidateLimit}|plugins=${(currentPluginSnapshot(state) || {}).generation || 0}|aliases=${aliasCatalogRevision(modelAliasData.aliases)}`;

    // Probe all providers concurrently and build the merged OpenAI list.
    const buildGlobalModelsResult = async () => {
      const upstreamProviders = SUPPORTED_SERVER_PROVIDERS.filter((provider) => provider !== 'codex');
      // 每个 provider 用一份隔离的运行态（避免共享 modelsCache 串味），
      // 但**保留引用**：探测结果里的 byAccount 是「模型属于谁」的直接证据，
      // 之前只取 ids，这批模型的归属就丢了（见下面 modelAccounts 的合并）。
      const upstreamStates = upstreamProviders.map((provider) => ({
        provider,
        state: { ...state, modelsCache: { updatedAt: 0, ids: [], byAccount: {}, sourceCount: 0 } }
      }));
      const [codexResult, ...upstreamResults] = await Promise.all([
        collectModelIdsFromHandler(handleCodexModels, {
          options,
          state,
          deps: { buildOpenAIModelsList, fetchWithTimeout, modelCatalogSettings }
        }),
        ...upstreamStates.map(({ provider, state: perProviderState }) => collectModelIdsFromHandler(handleUpstreamModels, {
          options: { ...options, provider },
          state: perProviderState,
          deps: { buildOpenAIModelsList, fetchModelsForAccount, FALLBACK_MODELS, modelCatalogSettings }
        }))
      ]);
      const upstreamEntries = upstreamProviders.flatMap((provider, index) => {
        const result = upstreamResults[index] || { ids: [] };
        return result.ids.map((id) => ({ id, provider, source: 'remote' }));
      });
      const aliases = modelAliasData.aliases;
      const modelCapabilityIndex = buildModelCapabilityIndex(state, options);
      // provider 级目录（byProvider / registry）没有账号归属，只能按「这个 provider
      // 此刻还有没有启用账号」来决定去留。构建期的账号快照随缓存体存下来，
      // 之后池里没有该 provider 的启用账号时，这些模型下一个请求就消失。
      const providerAccountRefs = new Map();
      SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
        const refs = (state.accounts && Array.isArray(state.accounts[provider]) ? state.accounts[provider] : [])
          .map((account) => String(account && account.accountRef || '').trim())
          .filter(Boolean);
        if (refs.length > 0) providerAccountRefs.set(provider, refs);
      });
      const mergedList = mergeGatewayModelEntries([
        // 复用上面那份能力索引：buildGatewayModelEntries 不传索引时会再全量扫一遍账号。
        ...buildGatewayModelEntries(state, options, modelCapabilityIndex),
        ...codexResult.ids.map((id) => ({ id, provider: 'codex', source: 'remote' })),
        ...upstreamEntries
      ], aliases, { state, options, modelCapabilityIndex, modelCatalogSettings });
      // 归属随缓存体一起存：池一变，旧体也能立刻按「谁在提供」收窄，
      // 不必等后台重建（详见 model-catalog-visibility#buildModelAccountEvidence）。
      const evidence = upstreamStates.reduce(
        (target, { state: perProviderState }) => addByAccountEvidence(
          target,
          perProviderState.modelsCache && perProviderState.modelsCache.byAccount
        ),
        buildModelAccountEvidence(modelCapabilityIndex)
      );
      // 没有任何账号级归属的条目（provider 级 registry / byProvider 目录）：有账号就
      // 记账号，没有账号就把「归属到哪个 provider」记下来，由读取方按 provider 是否还活着收窄。
      const providerBindings = {};
      mergedList.forEach((entry) => {
        // 别名是用户配置，不随账号状态消失。
        if (!entry || entry.source === 'alias') return;
        const provider = String(entry.provider || '').trim().toLowerCase();
        if (!provider) return;
        const refs = providerAccountRefs.get(provider);
        modelEvidenceLookupKeys(entry.id).forEach((key) => {
          if (evidence.has(key) || providerBindings[key]) return;
          if (refs) evidence.set(key, refs.slice());
          else providerBindings[key] = provider;
        });
      });
      return {
        codexResult,
        mergedList,
        modelAccounts: Object.fromEntries(evidence),
        modelProviders: providerBindings
      };
    };

    const pluginGeneration = (currentPluginSnapshot(state) || {}).generation || 0;
    // 归属表要进缓存快照（app-state.db），所以存普通对象而不是 Map。
    const serializeModelAccounts = (value) => {
      if (value instanceof Map) return Object.fromEntries(value);
      return value && typeof value === 'object' ? value : null;
    };
    const storeGlobalModelsCache = (mergedList, modelAccounts, modelProviders) => {
      const projection = buildModelCatalogProjection(mergedList, buildOpenAIModelsList);
      state.globalModelsCache = {
        updatedAt: Date.now(),
        pluginGeneration,
        signature: globalModelsSignature,
        body: JSON.stringify(buildOpenAIModelsList(mergedList)),
        modelAccounts: serializeModelAccounts(modelAccounts),
        modelProviders: serializeModelAccounts(modelProviders),
        projection
      };
      writePersistedGatewayModelCache({ fs, aiHomeDir }, state.globalModelsCache);
      if (typeof pushModelCatalogProjection === 'function') {
        Promise.resolve(pushModelCatalogProjection(projection)).catch(() => {});
      }
      return state.globalModelsCache;
    };

    const sendGlobalModelsBody = (body, cacheState, modelAccounts, modelProviders) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      // Public model metadata is safe to cache briefly in the browser too;
      // this absorbs route-transition bursts while the server refreshes in the
      // background.
      res.setHeader('cache-control', 'private, max-age=15, stale-while-revalidate=300');
      res.setHeader('x-aih-models-source', 'global-capability-pool');
      res.setHeader('x-aih-models-cache', cacheState);
      res.setHeader('x-aih-models-scope', 'available');
      // 对外口径 = 可见可用：只发布至少一个启用账号能服务的模型（WebUI 模型管理
      // 另有全量口径）。过滤发生在缓存读取之后 —— 缓存里永远是未过滤的体，
      // 所以账号一被关闭，下一个请求就是新口径，不必等后台刷新。
      const visibility = buildCatalogVisibility(state, options);
      // 钉选账号（x-account-ref）：harness 以某个账号启动时要的是「这个账号能用的模型」，
      // 不是全局池。只在该账号本身可见时收窄；未知或已停用的引用不改变口径（宁可多给，
      // 也不给出一个空目录让 harness 以为网关没有模型）。
      const pinnedRef = String((routingReq && routingReq.headers && routingReq.headers['x-account-ref']) || '').trim();
      if (pinnedRef && visibility.known && visibility.accountRefs.has(pinnedRef)) {
        visibility.accountRefs.forEach((ref) => { if (ref !== pinnedRef) { visibility.accountRefs.delete(ref); visibility.hiddenAccountRefs.add(ref); } });
        res.setHeader('x-aih-models-scope', 'account');
      }
      const byVisibility = filterOpenAIModelsBodyByCatalogVisibility(body, state, visibility, modelAccounts, modelProviders);
      if (visibility.known) {
        res.setHeader('x-aih-models-visible-accounts', String(visibility.accountRefs.size));
      }
      if (byVisibility.hidden > 0) {
        res.setHeader('x-aih-models-hidden-models', String(byVisibility.hidden));
      }
      // Capability filtering happens here, after the cache read: the cache
      // always stores the unfiltered body so one entry serves every query.
      res.end(filterOpenAIModelsBodyByCapability(byVisibility.body, modelsCapabilityFilter));
    };

    // A restart should not turn a warm gateway into a multi-second /models
    // outage.  The persisted snapshot is only a public model list; it is safe
    // to use as a read-through cache while the live catalog refreshes.
    if (!state.globalModelsCacheLoaded) {
      state.globalModelsCacheLoaded = true;
      const persisted = readPersistedGatewayModelCache({ fs, aiHomeDir });
      const current = state.globalModelsCache || {};
      if (!current.body && persisted.body) state.globalModelsCache = persisted;
    }
    const globalCache = state.globalModelsCache || {};
    const globalCacheFresh = globalCache.updatedAt > 0
      && Date.now() - globalCache.updatedAt < globalModelsTtl
      && globalCache.signature === globalModelsSignature
      && globalCache.body;
    const globalCacheInputsChanged = Boolean(
      globalCache.body
      && globalCache.signature
      && globalCache.signature !== globalModelsSignature
    );

    if (globalCacheFresh) {
      sendGlobalModelsBody(globalCache.body, 'hit', globalCache.modelAccounts, globalCache.modelProviders);
      return true;
    }

    // Any usable snapshot is preferable to blocking the client on a full
    // remote probe. Account/plugin/catalog signatures can change while the
    // previous public list remains renderable; refresh it in the background.
    // This is the hard latency boundary for /v1/models during refreshes.
    if (globalCache.body) {
      sendGlobalModelsBody(globalCache.body, globalCacheInputsChanged ? 'stale-inputs' : 'stale', globalCache.modelAccounts, globalCache.modelProviders);
      if (state.globalModelsRefreshing !== globalModelsSignature) {
        state.globalModelsRefreshing = globalModelsSignature;
        Promise.resolve()
          .then(buildGlobalModelsResult)
          .then(({ mergedList, modelAccounts, modelProviders }) => {
            if (mergedList.length > 0) storeGlobalModelsCache(mergedList, modelAccounts, modelProviders);
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
    const { codexResult, mergedList, modelAccounts, modelProviders } = await buildGlobalModelsResult();
    if (mergedList.length > 0) {
      const cached = storeGlobalModelsCache(mergedList, modelAccounts, modelProviders);
      sendGlobalModelsBody(cached.body, 'miss', cached.modelAccounts, cached.modelProviders);
      return true;
    }
    if (codexResult.statusCode >= 400 && codexResult.body) {
      res.statusCode = codexResult.statusCode;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(codexResult.body);
      return true;
    }
    await runModelsHandlerWithCapabilityFilter(res, modelsCapabilityFilter, (targetRes) => handleCodexModels({
      options,
      state,
      res: targetRes,
      deps: {
        buildOpenAIModelsList,
        fetchWithTimeout,
        modelCatalogSettings
      }
    }));
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
          refreshClaudeAccessToken,
          refreshAgyAccessToken,
          refreshKimiAccessToken,
          recordModelUsage,
          handleCodexChatCompletions,
          fs,
          aiHomeDir,
          providerSessionStateStore,
          handleUpstreamPassthrough,
          accountActivity
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
        refreshClaudeAccessToken,
        refreshAgyAccessToken,
        refreshKimiAccessToken,
        recordModelUsage,
        handleCodexChatCompletions,
        fs,
        aiHomeDir,
        providerSessionStateStore,
        handleUpstreamPassthrough,
        accountActivity,
        accountStateIndex
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
          refreshClaudeAccessToken,
          refreshAgyAccessToken,
          refreshKimiAccessToken,
          recordModelUsage,
          handleCodexChatCompletions,
          fs,
          aiHomeDir,
          providerSessionStateStore,
          handleUpstreamPassthrough,
          accountActivity,
          accountStateIndex
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
        refreshClaudeAccessToken,
        refreshAgyAccessToken,
        refreshKimiAccessToken,
        recordModelUsage,
        handleCodexChatCompletions,
        fs,
        aiHomeDir,
        providerSessionStateStore,
        handleUpstreamPassthrough,
        accountActivity
      }
    });
    if (isAliasRuntimeFailureResult(bridgeResult)) return bridgeResult;
    return true;
  }

  if (clientProtocol === 'openai_responses' && options.backend === 'codex-adapter') {
    const responseRequestJson = requestJson || {};
    const resolvedProvider = requireGatewayProvider(res, {
      options,
      state,
      requestJson: responseRequestJson,
      headers: routingReq && routingReq.headers,
      clientProtocol,
      aliasTargetProvider,
      preferModelRouting,
      aliasResolution
    });
    if (!resolvedProvider) return true;
    // 跨 provider 回落候选：模型名不变，只换 provider。上游把某个 provider 的整池都拒了
    // （档位不支持 / 额度耗尽 / 熔断）时，别的持有同一模型的 provider 仍可能服务。
    const responsesFallbacks = listCrossProviderFallbacks({
      state,
      options,
      model: String(responseRequestJson.model || '').trim(),
      currentProvider: resolvedProvider
    });
    let provider = resolvedProvider;
    for (let hop = 0; ; hop += 1) {
      const outcome = await runResponsesPathOnce(provider, responseRequestJson, {
        retryable: responsesFallbacks.length > 0
      });
      if (outcome.kind !== 'retryable') return true;
      if (res.headersSent || res.writableEnded) return true;
      const next = responsesFallbacks[hop];
      if (!next) {
        writeCrossProviderFailure(res, writeJson, outcome.failures);
        return true;
      }
      provider = next.provider;
    }
  }

  // 单次 responses 路径尝试：返回 retryable 表示「池耗尽且未向客户端写任何东西」，
  // 调用方可以换 provider 重来。把 provider 作为参数而不是闭包，才能在同一请求里换它。
  async function runResponsesPathOnce(provider, responseRequestJson, options_ = {}) {
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
          refreshClaudeAccessToken,
          refreshAgyAccessToken,
          refreshKimiAccessToken,
          recordModelUsage,
          accountActivity,
          accountStateIndex,
          fs,
          aiHomeDir,
          providerSessionStateStore
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
          refreshClaudeAccessToken,
          refreshAgyAccessToken,
          refreshKimiAccessToken,
          recordModelUsage,
          handleCodexChatCompletions,
          fs,
          aiHomeDir,
          providerSessionStateStore,
          handleUpstreamPassthrough,
          accountActivity
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
        refreshClaudeAccessToken,
        refreshAgyAccessToken,
        refreshKimiAccessToken,
        recordModelUsage,
        handleCodexChatCompletions,
        fs,
        aiHomeDir,
        providerSessionStateStore,
        handleUpstreamPassthrough,
        accountActivity
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
    // A codex account whose upstream only speaks chat/completions cannot be
    // served by the Responses adapter below; passthrough already speaks that
    // wire API natively.
    const codexViaChatCompletions = provider === 'codex' && shouldRouteCodexViaChatCompletions({
      state,
      requestJson: requestJson || {},
      requestedAccountRef: routingReq && routingReq.headers && routingReq.headers['x-account-ref']
    });
    if (provider !== 'codex' || codexViaChatCompletions) {
      const directRoute = codexViaChatCompletions
        ? null
        : resolveProviderProtocolRouteForClientRequest(clientProtocol, provider, requestJson || {});
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
            refreshClaudeAccessToken,
            refreshAgyAccessToken,
            refreshKimiAccessToken,
            recordModelUsage,
            handleCodexChatCompletions,
            fs,
            aiHomeDir,
            providerSessionStateStore,
            handleUpstreamPassthrough,
            accountActivity
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
          refreshClaudeAccessToken,
          refreshAgyAccessToken,
          refreshKimiAccessToken,
          recordModelUsage,
          // Relay chat requests need the same account egress context as Responses.
          fs,
          aiHomeDir,
          accountActivity
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
        refreshClaudeAccessToken,
        refreshAgyAccessToken,
        refreshKimiAccessToken,
        recordModelUsage,
        accountActivity,
        accountStateIndex,
        fs,
        aiHomeDir,
        providerSessionStateStore
      }
    });
    return true;
  }

  // OpenAI-compatible image generation / editing endpoints, dispatched through
  // the facade that reuses the shared provider router / account selector.
  if (method === 'POST' && isImageRequestPathname(pathname)) {
    await handleImageGenerations({
      req: routingReq,
      res,
      method,
      pathname,
      options,
      state,
      requestJson: requestJson || {},
      routeKey,
      requestStartedAt,
      cooldownMs,
      requestMeta: requestMetaWithSession,
      aliasTargetProvider,
      preferModelRouting,
      aliasResolution,
      deps: {
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
        recordModelUsage
      }
    });
    return true;
  }

  // Serve images that vision-image-guard stripped from non-vision requests, so a
  // vision-capable subagent can fetch them back. Behind the same client-key gate
  // as every other /v1 route (checked above).
  if (method === 'GET' && pathname.startsWith('/v1/blobs/')) {
    const blob = getImageBlob(pathname.slice('/v1/blobs/'.length));
    if (!blob) {
      writeJson(res, 404, { ok: false, error: 'blob_not_found' });
      return true;
    }
    res.writeHead(200, {
      'content-type': blob.mime,
      'content-length': blob.bytes.length,
      'cache-control': 'private, max-age=3600'
    });
    res.end(blob.bytes);
    return true;
  }

  if (method === 'GET' && pathname === '/v1/models') {
    await runModelsHandlerWithCapabilityFilter(res, modelsCapabilityFilter, (targetRes) => handleUpstreamModels({
      options,
      state,
      res: targetRes,
      deps: {
        buildOpenAIModelsList,
        fetchModelsForAccount,
        FALLBACK_MODELS,
        modelCatalogSettings
      }
    }));
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
      refreshClaudeAccessToken,
      refreshAgyAccessToken,
      refreshKimiAccessToken,
      recordModelUsage,
      // 账号出口解析需要存储上下文：漏传时出口服务会回落到默认数据目录，
      // 读到的就不是本服务实例的账号绑定（嵌入式/测试实例尤其如此）。
      fs,
      aiHomeDir,
      providerSessionStateStore,
      accountActivity
    }
  });
  if (isAliasRuntimeFailureResult(passthroughResult)) return passthroughResult;
  return true;
  };

  if (aliasCandidatesContext.candidates.length < 1) {
    // 直连请求（无别名）：先按原行为走。池耗尽时，如果**别的 provider 也持有同一个模型**，
    // 就换过去继续试 —— 否则一个 provider 的账号全被上游拒（档位不支持 / 额度耗尽 / 熔断）
  // 时请求直接失败，明明还有别的 provider 能服务。用户原话：「我们做 relay 的意义在哪里？
    // 这和我们一个一个手动切换有什么区别？」
    const crossProviderFallbacks = listCrossProviderFallbacks({
      state,
      options,
      model: String(originalRequestJson && originalRequestJson.model || '').trim(),
      currentProvider: aliasCandidatesContext.baseProvider
        || (typeof resolveRequestProvider === 'function'
          ? resolveRequestProvider(options, originalRequestJson, routingReq && routingReq.headers, state)
          : '')
    });
    if (crossProviderFallbacks.length < 1) {
      await runResolvedRequest(createResolvedRouteInput(null));
      return true;
    }
    // runtimeFallback: true 是关键 —— 没有它，池耗尽时返回的是已经写出去的普通失败，
    // 而不是「还能重试」的信号（见 upstream-endpoints 的 shouldDeferAliasRuntimeFailure）。
    const directFailures = [];
    const directResult = await runResolvedRequest(createResolvedRouteInput(null, { runtimeFallback: true }));
    if (!isAliasRuntimeFailureResult(directResult)) return true;
    directFailures.push(directResult);
    for (const fallback of crossProviderFallbacks) {
      if (res.headersSent || res.writableEnded) return true;
      // 「换 provider 再试一次」是一次子请求：日志里标记出它的父 span，
      // 事后能看出「这个请求为什么打了两个 provider」。
      const fallbackProvider = String(fallback && fallback.provider || '');
      const result = await runWithTrace(
        { label: `cross-provider:${fallbackProvider}` },
        () => runResolvedRequest(createCrossProviderRouteInput(fallback))
      );
      if (!isAliasRuntimeFailureResult(result)) return true;
      directFailures.push(result);
    }
    writeCrossProviderFailure(res, writeJson, directFailures);
    return true;
  }

  const runtimeFailures = [];
  let nativeRouteTried = false;
  // 别名与原生共用一个账号池：把两边当前可调度的账号交给调度器，按选号器同一权重决定先走哪条。
  const listRouteAccounts = (provider, model, aliasMatched) => {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const pool = Array.isArray(state && state.accounts && state.accounts[normalizedProvider])
      ? state.accounts[normalizedProvider]
      : [];
    if (!normalizedProvider || !model || pool.length < 1) return [];
    return selectPoolAccountsForModel({ pool, provider: normalizedProvider, model, state, options: options || {}, aliasMatched })
      .pool
      .map((account) => ({ account, provider: normalizedProvider }));
  };
  const firstAliasCandidate = aliasRouteCandidates[0] || null;
  const routeSources = orderModelRouteSources({
    hasAlias: aliasRouteCandidates.length > 0,
    hasNative: Boolean(nativeRouteFallback),
    aliasAccounts: firstAliasCandidate
      ? listRouteAccounts(resolveAliasUpstreamProvider(firstAliasCandidate), String(firstAliasCandidate.target || '').trim(), true)
      : [],
    nativeAccounts: nativeRouteFallback
      ? listRouteAccounts(nativeRouteFallback.provider, nativeRouteFallback.model, false)
      : [],
    accountActivity,
    strategy: state && state.strategy,
    cursors: state && (
      state.routeSourceCursors && typeof state.routeSourceCursors === 'object'
        ? state.routeSourceCursors
        : (state.routeSourceCursors = {})
    ),
    cursorKey: `alias-native:${aliasCandidatesContext.baseProvider || 'auto'}`
  });
  let remainingAliasCandidates = routeSources.flatMap((source) => (
    source === 'alias' ? aliasRouteCandidates : []
  ));
  if (routeSources[0] === 'native' && nativeRouteFallback) {
    nativeRouteTried = true;
    const nativeResult = await runResolvedRequest(createResolvedRouteInput(null, {
      runtimeFallback: true
    }));
    if (!isAliasRuntimeFailureResult(nativeResult)) return true;
    runtimeFailures.push(nativeResult);
  }
  while (remainingAliasCandidates.length > 0) {
    const aliasSelection = await selectAvailableAliasCandidate({
      candidates: remainingAliasCandidates,
      aliases: modelAliasData.aliases,
      state,
      options,
      fetchModelsForAccount
    });
    if (aliasSelection.matched && !aliasSelection.candidate) {
      if (nativeRouteFallback && !nativeRouteTried) {
        nativeRouteTried = true;
        await runResolvedRequest(createResolvedRouteInput(null));
        return true;
      }
      writeUnavailableAliasSelection(aliasSelection, remainingAliasCandidates, runtimeFailures);
      return true;
    }

    const candidate = aliasSelection.candidate;
    const result = await runResolvedRequest(createResolvedRouteInput(candidate, {
      allowModelCooled: Boolean(aliasSelection.lastResort)
    }));
    if (!isAliasRuntimeFailureResult(result)) return true;

    runtimeFailures.push(result);
    remainingAliasCandidates = remainingAliasCandidates.filter((item) => item && item.id !== candidate.id);
    if (res.headersSent || res.writableEnded) return true;
  }

  if (nativeRouteFallback && !nativeRouteTried) {
    nativeRouteTried = true;
    await runResolvedRequest(createResolvedRouteInput(null));
    return true;
  }
  writeAliasRuntimeFailure(res, writeJson, runtimeFailures[runtimeFailures.length - 1], runtimeFailures.slice(0, -1));
  return true;
}

module.exports = {
  handleV1Request,
  __private: {
    IMAGE_REQUEST_BODY_BYTES,
    buildModelCatalogProjection,
    resolveRequestBodyLimit,
    recordModelUsageRequestContext
  }
};

