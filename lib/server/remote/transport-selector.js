'use strict';

const {
  normalizeTransportRouteRole,
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

function transportScore(transport, preferredKinds = [], options = {}) {
  if (!transport || transport.disabled) return -1;
  if (!transportSupportsRemoteRequest(transport)) return -1;
  if (!routeRoleSupportsPurpose(transport, options.purpose)) return -1;
  if (!String(transport.endpoint || '').trim()) return -1;
  const base = Math.max(0, Math.min(100, Number(transport.score) || 0));
  const preferredIndex = preferredKinds.indexOf(String(transport.kind || '').trim());
  const preferenceBonus = preferredIndex >= 0 ? Math.max(0, 20 - preferredIndex * 2) : 0;
  const statusBonus = transport.status === 'up' ? 10 : (transport.status === 'degraded' ? 2 : 0);
  const latencyPenalty = Math.min(20, Math.floor((Number(transport.latencyMs) || 0) / 100));
  const relayPenalty = transport.kind === 'relay' ? RELAY_FALLBACK_PENALTY : 0;
  return base + preferenceBonus + statusBonus + purposeBonus(transport, options.purpose) - latencyPenalty - relayPenalty;
}

function selectTransport(node, transports = [], options = {}) {
  const preferredKinds = Array.isArray(node && node.preferredTransports) ? node.preferredTransports : [];
  return transports
    .map((transport) => ({
      transport,
      score: transportScore(transport, preferredKinds, options)
    }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score
      || String(a.transport.id || '').localeCompare(String(b.transport.id || '')))[0]?.transport || null;
}

module.exports = {
  RELAY_FALLBACK_PENALTY,
  PURPOSE_BONUS,
  normalizePurpose,
  routeRoleSupportsPurpose,
  transportScore,
  selectTransport
};
