'use strict';

const {
  readRemoteRegistry,
  replaceRegistryCollections,
  writeRemoteRegistry,
  nowMs
} = require('./remote-registry-store');
const { normalizeId } = require('./node-registry');

const SUPPORTED_TRANSPORT_KINDS = Object.freeze([
  'webrtc',
  'webtransport',
  'direct',
  'frp',
  'ssh',
  'tailscale',
  'zerotier',
  'wireguard',
  'omr',
  'mptcp',
  'relay'
]);

const HTTP_ENDPOINT_TRANSPORTS = new Set([
  'direct',
  'frp',
  'ssh',
  'tailscale',
  'zerotier',
  'wireguard',
  'omr',
  'mptcp'
]);

const REMOTE_REQUEST_TRANSPORTS = new Set([
  ...HTTP_ENDPOINT_TRANSPORTS,
  'relay'
]);

const SUPPORTED_TRANSPORT_ROUTE_ROLES = Object.freeze([
  'data-plane',
  'bootstrap',
  'underlay'
]);

const SUPPORTED_TRANSPORT_TRUST_LEVELS = Object.freeze([
  'managed',
  'verified',
  'external',
  'manual'
]);

const TRANSPORT_KIND_CATALOG = Object.freeze({
  webrtc: Object.freeze({
    kind: 'webrtc',
    label: 'WebRTC DataChannel',
    provider: 'webrtc',
    defaultRouteRole: 'data-plane',
    defaultTrustLevel: 'managed',
    lane: 'candidate',
    endpointMode: 'signaling',
    summary: 'Candidate transport: uses Fabric signaling plus ICE/DataChannel. It must pass promotion gates before it can carry remote RPC by default.'
  }),
  webtransport: Object.freeze({
    kind: 'webtransport',
    label: 'WebTransport/QUIC',
    provider: 'webtransport',
    defaultRouteRole: 'data-plane',
    defaultTrustLevel: 'managed',
    lane: 'candidate',
    endpointMode: 'https-h3',
    summary: 'Candidate transport: requires secure HTTP/3 WebTransport support and explicit fallback evidence before default use.'
  }),
  direct: Object.freeze({
    kind: 'direct',
    label: 'Direct HTTP',
    provider: 'direct',
    defaultRouteRole: 'data-plane',
    defaultTrustLevel: 'manual',
    lane: 'data-plane',
    endpointMode: 'http',
    summary: 'AIH data-plane over a reachable HTTP endpoint on LAN, public IP, or a user-managed overlay.'
  }),
  frp: Object.freeze({
    kind: 'frp',
    label: 'FRP',
    provider: 'frp',
    defaultRouteRole: 'data-plane',
    defaultTrustLevel: 'manual',
    lane: 'data-plane',
    endpointMode: 'http',
    summary: 'User-managed FRP HTTP endpoint; AI Home records and calls it but does not install or operate FRP.'
  }),
  ssh: Object.freeze({
    kind: 'ssh',
    label: 'SSH Tunnel',
    provider: 'openssh',
    defaultRouteRole: 'data-plane',
    defaultTrustLevel: 'manual',
    lane: 'bootstrap',
    endpointMode: 'http',
    summary: 'Preferred parallel bootstrap/probe channel; as a transport it must expose a real AIH HTTP tunnel endpoint.'
  }),
  tailscale: Object.freeze({
    kind: 'tailscale',
    label: 'Tailscale',
    provider: 'tailscale',
    defaultRouteRole: 'data-plane',
    defaultTrustLevel: 'verified',
    lane: 'data-plane',
    endpointMode: 'http',
    summary: 'Verified overlay HTTP endpoint, good for routine device and node RPC.'
  }),
  zerotier: Object.freeze({
    kind: 'zerotier',
    label: 'ZeroTier',
    provider: 'zerotier',
    defaultRouteRole: 'data-plane',
    defaultTrustLevel: 'verified',
    lane: 'data-plane',
    endpointMode: 'http',
    summary: 'Verified overlay HTTP endpoint, similar to Tailscale for cross-NAT access.'
  }),
  wireguard: Object.freeze({
    kind: 'wireguard',
    label: 'WireGuard',
    provider: 'wireguard',
    defaultRouteRole: 'data-plane',
    defaultTrustLevel: 'verified',
    lane: 'data-plane',
    endpointMode: 'http',
    summary: 'Verified VPN HTTP endpoint with low overhead for steady data-plane traffic.'
  }),
  omr: Object.freeze({
    kind: 'omr',
    label: 'OpenMPTCPRouter',
    provider: 'openmptcprouter',
    defaultRouteRole: 'underlay',
    defaultTrustLevel: 'external',
    lane: 'underlay',
    endpointMode: 'http',
    summary: 'Underlay only: OMR may improve the path below a reachable HTTP endpoint; AI Home does not manage OMR.'
  }),
  mptcp: Object.freeze({
    kind: 'mptcp',
    label: 'MPTCP',
    provider: 'mptcp',
    defaultRouteRole: 'underlay',
    defaultTrustLevel: 'external',
    lane: 'underlay',
    endpointMode: 'http',
    summary: 'Underlay only: MPTCP may improve an existing endpoint path; it is not an AIH-managed tunnel.'
  }),
  relay: Object.freeze({
    kind: 'relay',
    label: 'AIH Relay',
    provider: 'aih-relay',
    defaultRouteRole: 'data-plane',
    defaultTrustLevel: 'managed',
    lane: 'data-plane',
    endpointMode: 'relay',
    summary: 'AIH-managed default no-public-IP data-plane: the node keeps one outbound relay connection to the Control Plane.'
  })
});

function normalizeText(value, maxLength = 512) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeSlug(value, fallback = '', maxLength = 64) {
  const slug = normalizeText(value, maxLength)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
  return slug || fallback;
}

function normalizeTransportKind(value) {
  const kind = normalizeText(value, 64).toLowerCase();
  return SUPPORTED_TRANSPORT_KINDS.includes(kind) ? kind : '';
}

function normalizeTransportRouteRole(value) {
  const role = normalizeText(value, 64).toLowerCase();
  return SUPPORTED_TRANSPORT_ROUTE_ROLES.includes(role) ? role : 'data-plane';
}

function normalizeTransportTrustLevel(value) {
  const trustLevel = normalizeText(value, 64).toLowerCase();
  return SUPPORTED_TRANSPORT_TRUST_LEVELS.includes(trustLevel) ? trustLevel : 'manual';
}

function cloneTransportCatalogEntry(entry) {
  return entry ? { ...entry } : null;
}

function getTransportKindMetadata(kind) {
  const transportKind = normalizeTransportKind(kind);
  return cloneTransportCatalogEntry(TRANSPORT_KIND_CATALOG[transportKind]);
}

function getTransportKindCatalog() {
  return SUPPORTED_TRANSPORT_KINDS.reduce((catalog, kind) => {
    catalog[kind] = cloneTransportCatalogEntry(TRANSPORT_KIND_CATALOG[kind]);
    return catalog;
  }, {});
}

function normalizeEndpoint(value) {
  const endpoint = normalizeText(value, 2048).replace(/\/+$/, '');
  if (!endpoint) return '';
  try {
    const parsed = new URL(endpoint);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    return '';
  }
}

function normalizeRelayEndpoint(value, nodeId) {
  const fallback = nodeId ? `relay://${nodeId}` : '';
  const endpoint = normalizeText(value || fallback, 2048).replace(/\/+$/, '');
  if (!endpoint) return '';
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'relay:') return '';
    const host = normalizeId(parsed.hostname);
    return host ? `relay://${host}` : '';
  } catch (_error) {
    return '';
  }
}

function normalizeTransportPromotion(input = undefined, previous = {}) {
  if (input === null) return null;
  const source = input && typeof input === 'object' ? input : {};
  const existing = previous && typeof previous === 'object' ? previous : {};
  if (!Object.keys(source).length && !Object.keys(existing).length) return null;
  return {
    remoteRequestReady: Boolean(source.remoteRequestReady === undefined ? existing.remoteRequestReady : source.remoteRequestReady),
    mode: normalizeText(source.mode || existing.mode || '', 64),
    evidenceRef: normalizeText(source.evidenceRef || existing.evidenceRef || '', 256),
    rttP95Ms: Math.max(0, Number(source.rttP95Ms === undefined ? existing.rttP95Ms : source.rttP95Ms) || 0),
    rpcP95Ms: Math.max(0, Number(source.rpcP95Ms === undefined ? existing.rpcP95Ms : source.rpcP95Ms) || 0),
    promotedAt: Math.max(0, Number(source.promotedAt === undefined ? existing.promotedAt : source.promotedAt) || 0),
    expiresAt: Math.max(0, Number(source.expiresAt === undefined ? existing.expiresAt : source.expiresAt) || 0)
  };
}

function sanitizeTransport(input = {}, previous = null) {
  const source = input && typeof input === 'object' ? input : {};
  const previousTransport = previous && typeof previous === 'object' ? previous : {};
  const nodeId = normalizeId(source.nodeId || previousTransport.nodeId);
  const kind = normalizeTransportKind(source.kind || previousTransport.kind || 'direct');
  const id = normalizeId(source.id || previousTransport.id || `${nodeId}-${kind}`);
  if (!nodeId) {
    const error = new Error('invalid_transport_node_id');
    error.code = 'invalid_transport_node_id';
    throw error;
  }
  if (!id) {
    const error = new Error('invalid_transport_id');
    error.code = 'invalid_transport_id';
    throw error;
  }
  if (!kind) {
    const error = new Error('invalid_transport_kind');
    error.code = 'invalid_transport_kind';
    throw error;
  }
  const endpoint = kind === 'relay'
    ? normalizeRelayEndpoint(source.endpoint || previousTransport.endpoint, nodeId)
    : normalizeEndpoint(source.endpoint || previousTransport.endpoint);
  const now = nowMs();
  const promotion = normalizeTransportPromotion(source.promotion, previousTransport.promotion);
  const transport = {
    id,
    nodeId,
    kind,
    endpoint,
    status: normalizeText(source.status || previousTransport.status || 'unknown', 32),
    score: Math.max(0, Math.min(100, Number(source.score === undefined ? previousTransport.score : source.score) || 0)),
    latencyMs: Math.max(0, Number(source.latencyMs === undefined ? previousTransport.latencyMs : source.latencyMs) || 0),
    lastError: normalizeText(source.lastError === undefined ? previousTransport.lastError : source.lastError, 512),
    disabled: Boolean(source.disabled === undefined ? previousTransport.disabled : source.disabled),
    managedBy: normalizeText(source.managedBy || previousTransport.managedBy || 'aih', 64),
    provider: normalizeSlug(source.provider || previousTransport.provider || kind, kind, 64),
    routeRole: normalizeTransportRouteRole(source.routeRole || previousTransport.routeRole),
    trustLevel: normalizeTransportTrustLevel(source.trustLevel || previousTransport.trustLevel),
    setupHint: normalizeText(source.setupHint || previousTransport.setupHint || '', 512),
    createdAt: Number(previousTransport.createdAt || source.createdAt || now) || now,
    updatedAt: now
  };
  if (promotion) transport.promotion = promotion;
  return transport;
}

function listRemoteTransports(deps = {}) {
  return readRemoteRegistry(deps).transports.map((transport) => sanitizeTransport(transport, transport));
}

function listNodeTransports(nodeId, deps = {}) {
  const id = normalizeId(nodeId);
  if (!id) return [];
  return listRemoteTransports(deps).filter((transport) => transport.nodeId === id);
}

function upsertRemoteTransport(input, deps = {}) {
  const registry = readRemoteRegistry(deps);
  const sanitizedInput = input && typeof input === 'object' ? input : {};
  const inputId = normalizeId(sanitizedInput.id);
  const existing = inputId
    ? registry.transports.find((transport) => normalizeId(transport && transport.id) === inputId)
    : null;
  const transport = sanitizeTransport(input, existing);
  const transports = registry.transports.filter((entry) => normalizeId(entry && entry.id) !== transport.id);
  transports.push(transport);
  transports.sort((a, b) => String(a.nodeId || '').localeCompare(String(b.nodeId || ''))
    || String(a.kind || '').localeCompare(String(b.kind || ''))
    || String(a.id || '').localeCompare(String(b.id || '')));
  writeRemoteRegistry(replaceRegistryCollections(registry, { transports }), deps);
  return transport;
}

function transportSupportsHttp(transport) {
  return HTTP_ENDPOINT_TRANSPORTS.has(String(transport && transport.kind || '').trim());
}

function isTransportPromotionActive(transport) {
  const promotion = transport && transport.promotion && typeof transport.promotion === 'object'
    ? transport.promotion
    : {};
  if (promotion.remoteRequestReady !== true) return false;
  const expiresAt = Number(promotion.expiresAt || 0);
  return !expiresAt || expiresAt > nowMs();
}

function transportSupportsRemoteRequest(transport) {
  const kind = String(transport && transport.kind || '').trim();
  if (REMOTE_REQUEST_TRANSPORTS.has(kind)) return true;
  if (kind === 'webrtc') return isTransportPromotionActive(transport);
  return false;
}

module.exports = {
  SUPPORTED_TRANSPORT_KINDS,
  HTTP_ENDPOINT_TRANSPORTS,
  REMOTE_REQUEST_TRANSPORTS,
  SUPPORTED_TRANSPORT_ROUTE_ROLES,
  SUPPORTED_TRANSPORT_TRUST_LEVELS,
  TRANSPORT_KIND_CATALOG,
  getTransportKindCatalog,
  getTransportKindMetadata,
  normalizeTransportKind,
  normalizeEndpoint,
  normalizeTransportRouteRole,
  normalizeTransportTrustLevel,
  isTransportPromotionActive,
  sanitizeTransport,
  listRemoteTransports,
  listNodeTransports,
  normalizeTransportPromotion,
  upsertRemoteTransport,
  transportSupportsHttp,
  transportSupportsRemoteRequest
};
