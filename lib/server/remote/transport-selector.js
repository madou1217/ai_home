'use strict';

const {
  normalizeTransportRouteRole,
  normalizeTransportKind,
  transportSupportsRemoteRequest
} = require('./transport-registry');

const RELAY_FALLBACK_PENALTY = 45;

const PURPOSE_BONUS = Object.freeze({
  status: Object.freeze({
    direct: 8,
    tailscale: 8,
    zerotier: 7,
    wireguard: 7,
    frp: 5,
    ssh: 3,
    omr: 4,
    mptcp: 4,
    relay: 1
  }),
  read: Object.freeze({
    tailscale: 8,
    wireguard: 8,
    zerotier: 7,
    direct: 6,
    frp: 5,
    omr: 5,
    mptcp: 5,
    ssh: 3,
    relay: 1
  }),
  stream: Object.freeze({
    omr: 14,
    mptcp: 14,
    tailscale: 11,
    wireguard: 11,
    zerotier: 9,
    frp: 7,
    direct: 6,
    ssh: 4,
    relay: 1
  }),
  file: Object.freeze({
    direct: 10,
    tailscale: 10,
    wireguard: 10,
    omr: 9,
    mptcp: 9,
    zerotier: 8,
    frp: 6,
    ssh: 5,
    relay: 1
  }),
  runtime: Object.freeze({
    tailscale: 12,
    wireguard: 12,
    ssh: 10,
    zerotier: 9,
    direct: 7,
    frp: 6,
    omr: 6,
    mptcp: 6,
    relay: 1
  }),
  bootstrap: Object.freeze({
    ssh: 14,
    direct: 9,
    tailscale: 8,
    wireguard: 8,
    zerotier: 7,
    frp: 7,
    omr: 5,
    mptcp: 5,
    relay: 1
  })
});

function normalizePurpose(value) {
  const purpose = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PURPOSE_BONUS, purpose) ? purpose : 'read';
}

function purposeBonus(transport, purpose) {
  const bonuses = PURPOSE_BONUS[normalizePurpose(purpose)] || PURPOSE_BONUS.read;
  return Number(bonuses[String(transport && transport.kind || '').trim()]) || 0;
}

function routeRoleSupportsPurpose(transport, purpose) {
  const role = normalizeTransportRouteRole(transport && transport.routeRole);
  if (role === 'data-plane') return true;
  if (role === 'bootstrap') return normalizePurpose(purpose) === 'bootstrap';
  return false;
}

function normalizeAdapterList(value) {
  return new Set((Array.isArray(value) ? value : [])
    .map((item) => normalizeTransportKind(item))
    .filter(Boolean));
}

function adapterSupportsTransport(transport, options = {}) {
  const kind = normalizeTransportKind(transport && transport.kind);
  if (kind !== 'webrtc' && kind !== 'webtransport') return true;
  const adapters = normalizeAdapterList(options.availableAdapters);
  return adapters.has(kind);
}

function transportRejectionReason(transport, options = {}) {
  if (!transport) return 'missing_transport';
  if (transport.disabled) return 'transport_disabled';
  if (!transportSupportsRemoteRequest(transport)) {
    const kind = String(transport.kind || '').trim();
    if (kind === 'webrtc') return 'webrtc_not_promoted';
    if (kind === 'webtransport') return 'webtransport_not_promoted';
    return 'unsupported_remote_request';
  }
  if (!adapterSupportsTransport(transport, options)) {
    const kind = String(transport.kind || '').trim();
    if (kind === 'webrtc') return 'webrtc_adapter_not_available';
    if (kind === 'webtransport') return 'webtransport_adapter_not_available';
    return 'transport_adapter_not_available';
  }
  if (!routeRoleSupportsPurpose(transport, options.purpose)) return 'route_role_not_supported';
  if (!String(transport.endpoint || '').trim()) return 'missing_endpoint';
  return '';
}

function transportScore(transport, preferredKinds = [], options = {}) {
  if (transportRejectionReason(transport, options)) return -1;
  const base = Math.max(0, Math.min(100, Number(transport.score) || 0));
  const preferredIndex = preferredKinds.indexOf(String(transport.kind || '').trim());
  const preferenceBonus = preferredIndex >= 0 ? Math.max(0, 20 - preferredIndex * 2) : 0;
  const statusBonus = transport.status === 'up' ? 10 : (transport.status === 'degraded' ? 2 : 0);
  const latencyPenalty = Math.min(20, Math.floor((Number(transport.latencyMs) || 0) / 100));
  const relayPenalty = transport.kind === 'relay' ? RELAY_FALLBACK_PENALTY : 0;
  return base + preferenceBonus + statusBonus + purposeBonus(transport, options.purpose) - latencyPenalty - relayPenalty;
}

function evaluateTransport(transport, preferredKinds = [], options = {}) {
  const reason = transportRejectionReason(transport, options);
  return {
    transport,
    eligible: !reason,
    reason,
    score: reason ? -1 : transportScore(transport, preferredKinds, options)
  };
}

function sortEvaluatedTransports(left, right) {
  return right.score - left.score
    || String(left.transport && left.transport.id || '').localeCompare(String(right.transport && right.transport.id || ''));
}

function selectTransportDecision(node, transports = [], options = {}) {
  const preferredKinds = Array.isArray(node && node.preferredTransports) ? node.preferredTransports : [];
  const evaluated = transports.map((transport) => evaluateTransport(transport, preferredKinds, options));
  const selected = evaluated
    .filter((item) => item.eligible && item.score >= 0)
    .sort(sortEvaluatedTransports)[0] || null;
  const rejected = evaluated
    .filter((item) => !item.eligible)
    .map((item) => ({
      id: String(item.transport && item.transport.id || ''),
      kind: String(item.transport && item.transport.kind || ''),
      reason: item.reason
    }));
  const promotionFallbackFrom = rejected
    .filter((item) => item.reason === 'webrtc_not_promoted'
      || item.reason === 'webtransport_not_promoted'
      || item.reason === 'webrtc_adapter_not_available'
      || item.reason === 'webtransport_adapter_not_available')
    .map((item) => item.kind);
  const transport = selected ? selected.transport : null;
  return {
    transport,
    selected: transport,
    selectedTransportId: String(transport && transport.id || ''),
    selectedKind: String(transport && transport.kind || ''),
    fallbackUsed: Boolean(transport && transport.kind === 'relay' && promotionFallbackFrom.length > 0),
    fallbackFrom: Array.from(new Set(promotionFallbackFrom)),
    rejected
  };
}

function selectTransport(node, transports = [], options = {}) {
  return selectTransportDecision(node, transports, options).transport;
}

module.exports = {
  RELAY_FALLBACK_PENALTY,
  PURPOSE_BONUS,
  evaluateTransport,
  normalizePurpose,
  routeRoleSupportsPurpose,
  selectTransportDecision,
  transportScore,
  transportRejectionReason,
  selectTransport
};
