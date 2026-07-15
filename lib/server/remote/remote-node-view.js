'use strict';

const { listRemoteNodes } = require('./node-registry');
const { listRemoteTransports } = require('./transport-registry');

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function includeField(target, key, value, include) {
  if (include) target[key] = value;
}

function serializeRemoteConnectionForView(node, transports = [], deps = {}) {
  const relayTransport = transports.find((transport) => transport.kind === 'relay') || null;
  const registry = deps && deps.relaySessionRegistry;
  const session = registry && typeof registry.getRelaySession === 'function'
    ? registry.getRelaySession(node && node.id)
    : null;
  if (session) {
    return {
      status: 'online',
      transportKind: 'relay',
      transportId: String(session.transportId || (relayTransport && relayTransport.id) || '').trim(),
      sessionId: String(session.sessionId || '').trim(),
      remoteAddress: String(session.remoteAddress || '').trim(),
      connectedAt: numberOrZero(session.connectedAt),
      lastSeenAt: numberOrZero(session.lastSeenAt)
    };
  }
  if (relayTransport) {
    return {
      status: 'offline',
      transportKind: 'relay',
      transportId: relayTransport.id,
      sessionId: '',
      remoteAddress: '',
      connectedAt: 0,
      lastSeenAt: 0
    };
  }
  return {
    status: 'unknown',
    transportKind: '',
    transportId: '',
    sessionId: '',
    remoteAddress: '',
    connectedAt: 0,
    lastSeenAt: 0
  };
}

function serializeRemoteTransportForView(transport, options = {}) {
  const source = transport && typeof transport === 'object' ? transport : {};
  const view = {
    id: source.id,
    nodeId: source.nodeId,
    kind: source.kind,
    status: source.status,
    score: source.score,
    latencyMs: source.latencyMs,
    lastError: source.lastError,
    disabled: source.disabled,
    managedBy: source.managedBy,
    provider: source.provider,
    routeRole: source.routeRole,
    trustLevel: source.trustLevel,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt
  };
  includeField(view, 'endpoint', source.endpoint, Boolean(options.includeTransportEndpoint));
  includeField(view, 'setupHint', source.setupHint, Boolean(options.includeTransportSetupHint));
  return view;
}

function serializeRemoteNodeForView(node, transports = [], options = {}) {
  const source = node && typeof node === 'object' ? node : {};
  const connection = serializeRemoteConnectionForView(source, transports, options);
  const view = {
    id: source.id,
    name: source.name,
    role: source.role,
    endpointPolicy: source.endpointPolicy,
    preferredTransports: Array.isArray(source.preferredTransports) ? source.preferredTransports.slice() : [],
    capabilities: Array.isArray(source.capabilities) ? source.capabilities.slice() : [],
    fingerprint: source.fingerprint,
    tags: Array.isArray(source.tags) ? source.tags.slice() : [],
    disabled: source.disabled,
    lastSeenAt: source.lastSeenAt,
    connection,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    transports: transports.map((transport) => serializeRemoteTransportForView(transport, options))
  };
  includeField(view, 'authRef', source.authRef, Boolean(options.includeAuthRef));
  return view;
}

function listRemoteNodeViews(deps = {}, options = {}) {
  const transports = listRemoteTransports(deps);
  const viewOptions = {
    ...options,
    relaySessionRegistry: deps.relaySessionRegistry
  };
  return listRemoteNodes(deps).map((node) => serializeRemoteNodeForView(
    node,
    transports.filter((transport) => transport.nodeId === node.id),
    viewOptions
  ));
}

module.exports = {
  listRemoteNodeViews,
  serializeRemoteNodeForView,
  serializeRemoteConnectionForView,
  serializeRemoteTransportForView
};
