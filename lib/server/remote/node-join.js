'use strict';

const {
  normalizeId,
  upsertRemoteNode
} = require('./node-registry');
const {
  normalizeEndpoint,
  normalizeTransportKind,
  listNodeTransports,
  upsertRemoteTransport
} = require('./transport-registry');
const { writeRemoteSecret } = require('./secret-store');
const {
  assertInviteUsable,
  findInviteByCode,
  markInviteConsumed,
  serializeInvite
} = require('./pairing');
const {
  DEFAULT_REMOTE_TRANSPORT_KIND,
  resolveTransportProvider,
  resolveTransportRouteRole,
  resolveTransportTrustLevel
} = require('./node-defaults');

function normalizeText(value, maxLength = 256) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function slugifyId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 64);
}

function resolveJoinedNodeId(nodePayload, invite) {
  return normalizeId(nodePayload.id)
    || normalizeId(invite.nodeId)
    || normalizeId(slugifyId(nodePayload.name || invite.name))
    || normalizeId(`node-${String(invite.id || '').slice(0, 48)}`);
}

function buildJoinedNodeInput(nodePayload, invite) {
  const nodeId = resolveJoinedNodeId(nodePayload, invite);
  if (!nodeId) {
    const error = new Error('invalid_join_node_id');
    error.code = 'invalid_join_node_id';
    throw error;
  }
  return {
    id: nodeId,
    name: normalizeText(nodePayload.name || invite.name || nodeId, 120),
    role: normalizeText(nodePayload.role || invite.role || 'worker', 64),
    endpointPolicy: normalizeText(nodePayload.endpointPolicy || 'auto', 32),
    preferredTransports: Array.isArray(nodePayload.preferredTransports)
      ? nodePayload.preferredTransports
      : invite.preferredTransports,
    capabilities: Array.isArray(nodePayload.capabilities)
      ? nodePayload.capabilities
      : invite.capabilities,
    fingerprint: normalizeText(nodePayload.fingerprint, 160),
    tags: Array.from(new Set([
      ...(Array.isArray(invite.tags) ? invite.tags : []),
      ...(Array.isArray(nodePayload.tags) ? nodePayload.tags : [])
    ])),
    disabled: false,
    lastSeenAt: Date.now()
  };
}

function hasJoinEndpoint(payload, nodePayload) {
  return Boolean(
    nodePayload.endpoint
      || nodePayload.baseUrl
      || payload.endpoint
      || payload.baseUrl
      || payload.managementUrl
  );
}

function resolveJoinedTransportKind(payload, nodePayload, invite) {
  const explicitKind = nodePayload.transportKind || payload.transportKind;
  if (explicitKind) return normalizeTransportKind(explicitKind) || DEFAULT_REMOTE_TRANSPORT_KIND;
  if (hasJoinEndpoint(payload, nodePayload)) return 'direct';
  return normalizeTransportKind(invite.transportKind || DEFAULT_REMOTE_TRANSPORT_KIND) || DEFAULT_REMOTE_TRANSPORT_KIND;
}

function inheritInviteTransportField(invite, kind, field) {
  return invite.transportKind === kind ? invite[field] : '';
}

function buildInlineTransportInput(node, payload, nodePayload, invite) {
  const kind = resolveJoinedTransportKind(payload, nodePayload, invite);
  const endpoint = kind === 'relay' ? `relay://${node.id}` : normalizeEndpoint(
    nodePayload.endpoint
      || nodePayload.baseUrl
      || payload.endpoint
      || payload.baseUrl
      || invite.endpointHint
  );
  if (!endpoint) return null;
  return {
    id: `${node.id}-${kind}`,
    nodeId: node.id,
    kind,
    endpoint,
    status: 'unknown',
    score: 60,
    managedBy: normalizeText(nodePayload.managedBy || payload.managedBy || 'pairing', 64),
    provider: normalizeText(
      nodePayload.provider
        || payload.provider
        || inheritInviteTransportField(invite, kind, 'provider')
        || resolveTransportProvider(kind),
      64
    ),
    routeRole: resolveTransportRouteRole(
      kind,
      nodePayload.routeRole || payload.routeRole || inheritInviteTransportField(invite, kind, 'routeRole')
    ),
    trustLevel: resolveTransportTrustLevel(
      kind,
      nodePayload.trustLevel || payload.trustLevel || inheritInviteTransportField(invite, kind, 'trustLevel')
    ),
    setupHint: normalizeText(nodePayload.setupHint || payload.setupHint || invite.setupHint || '', 512)
  };
}

function buildTransportInputs(node, payload, nodePayload, invite) {
  const explicitTransports = Array.isArray(payload.transports) ? payload.transports : [];
  const inlineTransport = buildInlineTransportInput(node, payload, nodePayload, invite);
  return explicitTransports
    .concat(inlineTransport ? [inlineTransport] : [])
    .map((transport) => ({
      ...transport,
      nodeId: node.id
    }));
}

function extractJoinSecret(payload, nodePayload) {
  return {
    managementKey: normalizeText(
      nodePayload.managementKey
        || payload.managementKey
        || payload.nodePairToken
        || payload.token,
      4096
    )
  };
}

function serializeJoinedNode(node, transports) {
  return {
    ...node,
    transports
  };
}

function joinRemoteNodeWithInvite(payload = {}, deps = {}) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const code = normalizeText(source.code, 256);
  const invite = findInviteByCode(code, deps);
  assertInviteUsable(invite);

  const nodePayload = source.node && typeof source.node === 'object' ? source.node : source;
  const node = upsertRemoteNode(buildJoinedNodeInput(nodePayload, invite), deps);
  const secret = extractJoinSecret(source, nodePayload);
  if (secret.managementKey) {
    writeRemoteSecret(node.authRef, secret, deps);
  }

  const transportInputs = buildTransportInputs(node, source, nodePayload, invite);
  const transports = transportInputs.map((transport) => upsertRemoteTransport(transport, deps));
  const consumedInvite = markInviteConsumed(invite.id, deps);
  return {
    invite: consumedInvite || serializeInvite(invite),
    node: serializeJoinedNode(node, transports.length ? transports : listNodeTransports(node.id, deps))
  };
}

module.exports = {
  joinRemoteNodeWithInvite
};
