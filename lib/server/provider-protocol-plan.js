'use strict';

const { resolveProtocolRequestAdapterPath } = require('./protocol-request-adapter-registry');
const { createProviderProtocolRouteMeta } = require('./provider-protocol-routing');

const PROVIDER_PROTOCOL_CANONICAL_EVENT_PROTOCOL = 'aih_canonical_events';

function normalizeText(value) {
  return String(value || '').trim();
}

function listAdapterIds(adapters) {
  return (Array.isArray(adapters) ? adapters : [])
    .map((adapter) => normalizeText(adapter && adapter.id))
    .filter(Boolean);
}

function freezeArray(values) {
  return Object.freeze((Array.isArray(values) ? values : []).slice());
}

function resolveRequestAdapterPath(sourceProtocol, targetProtocol) {
  const source = normalizeText(sourceProtocol);
  const target = normalizeText(targetProtocol);
  if (!source || !target) return null;
  if (source === target) return [];
  return resolveProtocolRequestAdapterPath(source, target);
}

function createProviderProtocolPlan(input = {}) {
  const route = createProviderProtocolRouteMeta(input.route || input.providerProtocolRoute);
  if (!route) return null;

  const sourceClientProtocol = normalizeText(
    input.sourceClientProtocol
    || input.clientProtocol
    || route.clientProtocol
  );
  const routeClientProtocol = normalizeText(route.clientProtocol);
  const requestAdapters = resolveRequestAdapterPath(sourceClientProtocol, routeClientProtocol);
  if (!Array.isArray(requestAdapters)) return null;

  const requestAdapterPath = listAdapterIds(requestAdapters);
  const responseAdapterPath = listAdapterIds([...requestAdapters].reverse());
  const provider = normalizeText(input.provider || route.provider);
  const transport = normalizeText(route.transport);

  return Object.freeze({
    id: `${sourceClientProtocol}->${routeClientProtocol}:${provider}:${transport}`,
    sourceClientProtocol,
    clientProtocol: routeClientProtocol,
    routeClientProtocol,
    provider,
    transport,
    upstreamProtocol: normalizeText(route.upstreamProtocol),
    requestAdapter: normalizeText(route.requestAdapter),
    responseAdapter: normalizeText(route.responseAdapter),
    requestAdapterPath: freezeArray(requestAdapterPath),
    responseAdapterPath: freezeArray(responseAdapterPath),
    upstreamRequestAdapter: normalizeText(route.requestAdapter),
    downstreamResponseAdapter: normalizeText(route.responseAdapter),
    canonicalEventProtocol: PROVIDER_PROTOCOL_CANONICAL_EVENT_PROTOCOL,
    nativeDirect: requestAdapterPath.length === 0,
    route
  });
}

function compactProviderProtocolPlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  return Object.freeze({
    id: normalizeText(plan.id),
    sourceClientProtocol: normalizeText(plan.sourceClientProtocol),
    clientProtocol: normalizeText(plan.clientProtocol),
    routeClientProtocol: normalizeText(plan.routeClientProtocol || plan.clientProtocol),
    provider: normalizeText(plan.provider),
    transport: normalizeText(plan.transport),
    upstreamProtocol: normalizeText(plan.upstreamProtocol),
    requestAdapter: normalizeText(plan.requestAdapter),
    responseAdapter: normalizeText(plan.responseAdapter),
    requestAdapterPath: freezeArray(plan.requestAdapterPath),
    responseAdapterPath: freezeArray(plan.responseAdapterPath),
    upstreamRequestAdapter: normalizeText(plan.upstreamRequestAdapter || plan.requestAdapter),
    downstreamResponseAdapter: normalizeText(plan.downstreamResponseAdapter || plan.responseAdapter),
    canonicalEventProtocol: normalizeText(plan.canonicalEventProtocol) || PROVIDER_PROTOCOL_CANONICAL_EVENT_PROTOCOL,
    nativeDirect: Boolean(plan.nativeDirect)
  });
}

function mergeProviderProtocolPlanIntoRequestMeta(requestMeta, input = {}) {
  const baseMeta = requestMeta && typeof requestMeta === 'object' ? requestMeta : {};
  const route = input.route || input.providerProtocolRoute || baseMeta.providerProtocolRoute;
  const sourceClientProtocol = normalizeText(
    input.sourceClientProtocol
    || baseMeta.sourceClientProtocol
    || baseMeta.clientProtocol
  );
  const plan = createProviderProtocolPlan({
    route,
    provider: input.provider || baseMeta.effectiveProvider,
    sourceClientProtocol,
    clientProtocol: input.clientProtocol || baseMeta.clientProtocol
  });
  const compactPlan = compactProviderProtocolPlan(plan);
  if (!compactPlan) return baseMeta;
  const existingAdapterPath = Array.isArray(baseMeta.protocolAdapterPath)
    ? baseMeta.protocolAdapterPath.filter(Boolean)
    : [];
  return {
    ...baseMeta,
    sourceClientProtocol: compactPlan.sourceClientProtocol,
    clientProtocol: compactPlan.clientProtocol,
    protocolAdapterPath: existingAdapterPath.length > 0
      ? existingAdapterPath
      : compactPlan.requestAdapterPath.slice(),
    providerProtocolPlan: compactPlan
  };
}

module.exports = {
  PROVIDER_PROTOCOL_CANONICAL_EVENT_PROTOCOL,
  compactProviderProtocolPlan,
  createProviderProtocolPlan,
  mergeProviderProtocolPlanIntoRequestMeta,
  __private: {
    freezeArray,
    listAdapterIds,
    normalizeText,
    resolveRequestAdapterPath
  }
};
