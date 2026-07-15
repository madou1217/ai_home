'use strict';

const { resolveProtocolRequestAdapterPath } = require('./protocol-request-adapter-registry');
const { normalizeModelId } = require('./providers');

const PROVIDER_PROTOCOL_TRANSPORTS = Object.freeze({
  PROVIDER_PASSTHROUGH: 'provider_passthrough',
  CODE_ASSIST_ANTHROPIC_DIRECT: 'code_assist_anthropic_direct',
  OPENCODE_GO_API: 'opencode_go_api'
});

const AGY_DIRECT_ADAPTERS = Object.freeze({
  requestAdapter: 'claude2agyAdapter',
  responseAdapter: 'agy2claudeAdapter'
});

const PROVIDER_PROTOCOL_ROUTES = Object.freeze([
  Object.freeze({
    id: 'anthropic_messages:claude:passthrough',
    clientProtocol: 'anthropic_messages',
    provider: 'claude',
    transport: PROVIDER_PROTOCOL_TRANSPORTS.PROVIDER_PASSTHROUGH,
    upstreamProtocol: 'anthropic_messages',
    requestAdapter: null,
    responseAdapter: null
  }),
  Object.freeze({
    id: 'anthropic_messages:agy:code_assist_direct',
    clientProtocol: 'anthropic_messages',
    provider: 'agy',
    transport: PROVIDER_PROTOCOL_TRANSPORTS.CODE_ASSIST_ANTHROPIC_DIRECT,
    upstreamProtocol: 'gemini_code_assist_generate_content',
    requestAdapter: AGY_DIRECT_ADAPTERS.requestAdapter,
    responseAdapter: AGY_DIRECT_ADAPTERS.responseAdapter,
    modelFamilies: Object.freeze(['anthropic'])
  }),
  Object.freeze({
    id: 'openai_chat:opencode:go_api',
    clientProtocol: 'openai_chat',
    provider: 'opencode',
    transport: PROVIDER_PROTOCOL_TRANSPORTS.OPENCODE_GO_API,
    upstreamProtocol: 'opencode_go_chat',
    requestAdapter: null,
    responseAdapter: null
  })
]);

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function indexProviderProtocolRoutes(routes) {
  const index = {};
  (Array.isArray(routes) ? routes : []).forEach((route) => {
    if (!route || typeof route !== 'object') return;
    const protocol = normalizeKey(route.clientProtocol);
    const provider = normalizeKey(route.provider);
    if (!protocol || !provider) return;
    if (!index[protocol]) index[protocol] = {};
    if (!Array.isArray(index[protocol][provider])) index[protocol][provider] = [];
    index[protocol][provider].push(route);
  });
  return Object.freeze(Object.fromEntries(
    Object.entries(index).map(([protocol, providers]) => [
      protocol,
      Object.freeze(Object.fromEntries(
        Object.entries(providers).map(([provider, providerRoutes]) => [
          provider,
          Object.freeze(providerRoutes.slice())
        ])
      ))
    ])
  ));
}

const PROVIDER_PROTOCOL_ROUTE_INDEX = indexProviderProtocolRoutes(PROVIDER_PROTOCOL_ROUTES);

const PROVIDER_PROTOCOL_COMMON_DEPENDENCY_KEYS = Object.freeze([
  'chooseServerAccount',
  'resolveRequestProvider',
  'pushMetricError',
  'writeJson',
  'fetchWithTimeout',
  'markProxyAccountFailure',
  'markProxyAccountSuccess',
  'appendProxyRequestLog'
]);

const PROVIDER_PROTOCOL_OPTIONAL_DEPENDENCY_KEYS = Object.freeze([
  'recordModelUsage'
]);

const TRANSPORT_OPTIONAL_DEPENDENCY_KEYS = Object.freeze({
  [PROVIDER_PROTOCOL_TRANSPORTS.PROVIDER_PASSTHROUGH]: Object.freeze([
    'refreshClaudeAccessToken'
  ])
});

const TRANSPORT_EXTRA_DEPENDENCY_KEYS = Object.freeze({
  [PROVIDER_PROTOCOL_TRANSPORTS.PROVIDER_PASSTHROUGH]: Object.freeze([]),
  [PROVIDER_PROTOCOL_TRANSPORTS.CODE_ASSIST_ANTHROPIC_DIRECT]: Object.freeze([
    'fetchCodeAssistAnthropicMessage',
    'fetchCodeAssistAnthropicMessageStream'
  ]),
  [PROVIDER_PROTOCOL_TRANSPORTS.OPENCODE_GO_API]: Object.freeze([
    'fetchOpenCodeChatCompletion',
    'fetchOpenCodeChatCompletionStream'
  ])
});

const TRANSPORT_ROUTE_REQUIREMENTS = Object.freeze({
  [PROVIDER_PROTOCOL_TRANSPORTS.PROVIDER_PASSTHROUGH]: Object.freeze({
    upstreamProtocol: 'anthropic_messages',
    requestAdapter: null,
    responseAdapter: null
  }),
  [PROVIDER_PROTOCOL_TRANSPORTS.CODE_ASSIST_ANTHROPIC_DIRECT]: Object.freeze({
    upstreamProtocol: 'gemini_code_assist_generate_content',
    requestAdapter: AGY_DIRECT_ADAPTERS.requestAdapter,
    responseAdapter: AGY_DIRECT_ADAPTERS.responseAdapter
  }),
  [PROVIDER_PROTOCOL_TRANSPORTS.OPENCODE_GO_API]: Object.freeze({
    upstreamProtocol: 'opencode_go_chat',
    requestAdapter: null,
    responseAdapter: null
  })
});

function createProviderProtocolRouteMeta(route) {
  if (!route || typeof route !== 'object') return null;
  const modelFamilies = Array.isArray(route.modelFamilies)
    ? route.modelFamilies.map(normalizeKey).filter(Boolean)
    : [];
  return Object.freeze({
    id: route.id,
    clientProtocol: route.clientProtocol,
    provider: route.provider,
    transport: route.transport,
    upstreamProtocol: route.upstreamProtocol,
    requestAdapter: route.requestAdapter || null,
    responseAdapter: route.responseAdapter || null,
    ...(route.allowClientProtocolBridge === false ? { allowClientProtocolBridge: false } : {}),
    ...(modelFamilies.length > 0 ? { modelFamilies: Object.freeze(modelFamilies) } : {})
  });
}

function modelMatchesFamily(model, family) {
  const modelId = normalizeModelId(model);
  const familyId = normalizeKey(family);
  if (!modelId || !familyId) return false;
  if (familyId === 'anthropic') {
    return /(^|[^a-z0-9])(claude|anthropic)([^a-z0-9]|$)/.test(modelId);
  }
  return modelId.startsWith(familyId);
}

function routeMatchesRequest(route, requestJson = {}) {
  if (!route || typeof route !== 'object') return false;
  const modelFamilies = Array.isArray(route.modelFamilies) ? route.modelFamilies : [];
  if (modelFamilies.length === 0) return true;
  return modelFamilies.some((family) => modelMatchesFamily(requestJson && requestJson.model, family));
}

function routeFieldMatches(route, key, expectedValue) {
  const actualValue = route && route[key];
  if (expectedValue === null) return actualValue === null || actualValue === undefined || actualValue === '';
  return normalizeKey(actualValue) === normalizeKey(expectedValue);
}

function resolveProviderProtocolRoutePlan(requestMeta) {
  const route = createProviderProtocolRouteMeta(requestMeta && requestMeta.providerProtocolRoute);
  if (!route) return null;
  const requirements = TRANSPORT_ROUTE_REQUIREMENTS[normalizeKey(route.transport)];
  if (!requirements) return null;
  const matches = Object.entries(requirements).every(([key, expectedValue]) => (
    routeFieldMatches(route, key, expectedValue)
  ));
  return matches ? route : null;
}

function resolveProviderProtocolTransport(requestMeta) {
  const route = resolveProviderProtocolRoutePlan(requestMeta);
  return normalizeKey(route && route.transport);
}

function listDirectProviderProtocolRoutesFromIndex(routeIndex, clientProtocol, provider) {
  const protocolRoutes = routeIndex && routeIndex[normalizeKey(clientProtocol)];
  if (!protocolRoutes) return [];
  const routes = protocolRoutes[normalizeKey(provider)];
  return Array.isArray(routes) ? routes : [];
}

function listDirectProviderProtocolRoutes(clientProtocol, provider) {
  return listDirectProviderProtocolRoutesFromIndex(PROVIDER_PROTOCOL_ROUTE_INDEX, clientProtocol, provider);
}

function resolveDirectProviderProtocolRoute(clientProtocol, provider) {
  return listDirectProviderProtocolRoutes(clientProtocol, provider)[0] || null;
}

function resolveProviderProtocolRouteForRequestFromIndex(routeIndex, clientProtocol, provider, requestJson = {}) {
  return listDirectProviderProtocolRoutesFromIndex(routeIndex, clientProtocol, provider)
    .find((route) => routeMatchesRequest(route, requestJson)) || null;
}

function resolveProviderProtocolRouteForRequest(clientProtocol, provider, requestJson = {}) {
  return resolveProviderProtocolRouteForRequestFromIndex(
    PROVIDER_PROTOCOL_ROUTE_INDEX,
    clientProtocol,
    provider,
    requestJson
  );
}

function listProviderProtocolRouteCandidates(provider, requestJson = {}) {
  const targetProvider = normalizeKey(provider);
  if (!targetProvider) return [];
  return PROVIDER_PROTOCOL_ROUTES.filter((route) => (
    normalizeKey(route && route.provider) === targetProvider
    && routeMatchesRequest(route, requestJson)
  ));
}

function resolveClientToRouteAdapterPath(clientProtocol, route) {
  const sourceProtocol = normalizeKey(clientProtocol);
  const targetProtocol = normalizeKey(route && route.clientProtocol);
  if (!sourceProtocol || !targetProtocol) return null;
  if (sourceProtocol === targetProtocol) return [];
  return resolveProtocolRequestAdapterPath(sourceProtocol, targetProtocol);
}

function canReachProviderProtocolRoute(clientProtocol, route) {
  if (
    route
    && route.allowClientProtocolBridge === false
    && normalizeKey(clientProtocol) !== normalizeKey(route.clientProtocol)
  ) {
    return false;
  }
  return Array.isArray(resolveClientToRouteAdapterPath(clientProtocol, route));
}

function compareProviderProtocolRoutesForClient(clientProtocol, left, right) {
  const leftPath = resolveClientToRouteAdapterPath(clientProtocol, left);
  const rightPath = resolveClientToRouteAdapterPath(clientProtocol, right);
  const leftCost = Array.isArray(leftPath) ? leftPath.length : Number.POSITIVE_INFINITY;
  const rightCost = Array.isArray(rightPath) ? rightPath.length : Number.POSITIVE_INFINITY;
  if (leftCost !== rightCost) return leftCost - rightCost;
  return PROVIDER_PROTOCOL_ROUTES.indexOf(left) - PROVIDER_PROTOCOL_ROUTES.indexOf(right);
}

function resolveProviderProtocolRouteForClientRequest(clientProtocol, provider, requestJson = {}) {
  const directRoute = resolveProviderProtocolRouteForRequest(clientProtocol, provider, requestJson);
  if (directRoute) return directRoute;
  return listProviderProtocolRouteCandidates(provider, requestJson)
    .filter((route) => canReachProviderProtocolRoute(clientProtocol, route))
    .sort((left, right) => compareProviderProtocolRoutesForClient(clientProtocol, left, right))[0] || null;
}

function createProviderProtocolRouteDeps(route, deps = {}) {
  if (!route || typeof route !== 'object') return null;
  const extraKeys = TRANSPORT_EXTRA_DEPENDENCY_KEYS[normalizeKey(route.transport)];
  if (!extraKeys) return null;
  const requiredKeys = [...PROVIDER_PROTOCOL_COMMON_DEPENDENCY_KEYS, ...extraKeys];
  const missingRequiredKey = requiredKeys.find((key) => typeof deps[key] !== 'function');
  if (missingRequiredKey) return null;
  const out = {};
  requiredKeys.forEach((key) => { out[key] = deps[key]; });
  const optionalKeys = [
    ...PROVIDER_PROTOCOL_OPTIONAL_DEPENDENCY_KEYS,
    ...(TRANSPORT_OPTIONAL_DEPENDENCY_KEYS[normalizeKey(route.transport)] || [])
  ];
  optionalKeys.forEach((key) => {
    if (typeof deps[key] === 'function') out[key] = deps[key];
  });
  return out;
}

module.exports = {
  createProviderProtocolRouteMeta,
  createProviderProtocolRouteDeps,
  resolveProviderProtocolRoutePlan,
  PROVIDER_PROTOCOL_TRANSPORTS,
  resolveProviderProtocolTransport,
  resolveDirectProviderProtocolRoute,
  resolveProviderProtocolRouteForRequest,
  resolveProviderProtocolRouteForClientRequest,
  __private: {
    PROVIDER_PROTOCOL_COMMON_DEPENDENCY_KEYS,
    PROVIDER_PROTOCOL_OPTIONAL_DEPENDENCY_KEYS,
    PROVIDER_PROTOCOL_ROUTES,
    PROVIDER_PROTOCOL_ROUTE_INDEX,
    PROVIDER_PROTOCOL_TRANSPORTS,
    TRANSPORT_ROUTE_REQUIREMENTS,
    TRANSPORT_EXTRA_DEPENDENCY_KEYS,
    TRANSPORT_OPTIONAL_DEPENDENCY_KEYS,
    createProviderProtocolRouteMeta,
    canReachProviderProtocolRoute,
    compareProviderProtocolRoutesForClient,
    listProviderProtocolRouteCandidates,
    listDirectProviderProtocolRoutes,
    listDirectProviderProtocolRoutesFromIndex,
    modelMatchesFamily,
    normalizeKey,
    indexProviderProtocolRoutes,
    resolveProviderProtocolRouteForRequestFromIndex,
    resolveClientToRouteAdapterPath,
    routeMatchesRequest
  }
};
