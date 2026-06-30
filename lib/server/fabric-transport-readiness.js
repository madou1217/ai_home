'use strict';

const { buildFabricNodeInventory } = require('./fabric-node-inventory');
const {
  getTransportKindMetadata,
  normalizeTransportKind
} = require('./remote/transport-registry');
const {
  selectTransportDecision
} = require('./remote/transport-selector');

const ADVANCED_TRANSPORT_KINDS = Object.freeze(['webrtc', 'webtransport', 'omr', 'mptcp']);

function normalizeText(value, maxLength = 512) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeId(value) {
  return normalizeText(value, 128)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
}

function normalizePurpose(value) {
  const purpose = normalizeText(value, 64).toLowerCase();
  return ['status', 'read', 'stream', 'file', 'runtime', 'bootstrap'].includes(purpose) ? purpose : 'runtime';
}

function normalizeAdapterList(value) {
  return new Set((Array.isArray(value) ? value : [])
    .map((item) => normalizeText(item, 64))
    .filter(Boolean));
}

function statusFromHealth(value) {
  const health = normalizeText(value, 32).toLowerCase();
  if (health === 'online' || health === 'up' || health === 'healthy') return 'up';
  if (health === 'offline' || health === 'down' || health === 'failed' || health === 'unhealthy') return 'down';
  if (health === 'degraded' || health === 'warning') return 'degraded';
  return health || 'unknown';
}

function latestMeasurementForTransport(transport, measurements = []) {
  const transportId = normalizeId(transport && transport.id);
  const nodeId = normalizeId(transport && transport.nodeId);
  const kind = normalizeText(transport && transport.kind, 64);
  const direct = transport && transport.measurement && typeof transport.measurement === 'object'
    ? {
      ...transport.measurement,
      transportId,
      transportKind: kind,
      nodeId,
      source: 'transport'
    }
    : null;
  const candidates = (Array.isArray(measurements) ? measurements : [])
    .filter((item) => normalizeId(item && item.transportId) === transportId)
    .sort((left, right) => Number(right && right.measuredAt || 0) - Number(left && left.measuredAt || 0));
  const latest = candidates[0] || direct;
  if (!latest) return null;
  return {
    status: normalizeText(latest.status, 96),
    sampleCount: Number(latest.sampleCount || latest.successes || 0),
    successRate: latest.successRate === undefined ? null : Number(latest.successRate),
    successes: Number(latest.successes || 0),
    failures: Number(latest.failures || 0),
    failureReason: normalizeText(latest.failureReason, 160),
    rttMs: latest.rttMs && typeof latest.rttMs === 'object' ? latest.rttMs : null,
    measuredAt: Number(latest.measuredAt || 0),
    source: latest.source || 'networkMeasurements'
  };
}

function measurementPasses(measurement) {
  if (!measurement) return false;
  if (measurement.status && measurement.status !== 'ws_echo_pass') return false;
  if (measurement.successRate !== null && measurement.successRate < 1) return false;
  if (Number(measurement.failures || 0) > 0) return false;
  return Number(measurement.sampleCount || 0) > 0 || Number(measurement.successes || 0) > 0;
}

function toSelectorTransport(transport, measurements = []) {
  const kind = normalizeTransportKind(transport && transport.kind);
  if (!kind) return null;
  const measurement = latestMeasurementForTransport(transport, measurements);
  const rtt = measurement && measurement.rttMs ? measurement.rttMs : {};
  const priority = Number(transport && transport.priority);
  const status = statusFromHealth(transport && (transport.health || transport.status));
  const priorityScore = Number.isFinite(priority) ? Math.max(0, Math.min(100, 100 - priority)) : 55;
  const score = kind === 'relay' && (status === 'up' || status === 'degraded')
    ? Math.max(55, priorityScore)
    : priorityScore;
  return {
    id: normalizeId(transport && transport.id),
    nodeId: normalizeId(transport && transport.nodeId),
    kind,
    endpoint: normalizeText(transport && transport.endpoint, 2048),
    status,
    score,
    latencyMs: Number(rtt.p95 || rtt.avg || rtt.p50 || 0),
    lastError: normalizeText(transport && transport.lastError, 512) || (measurement && measurement.failureReason) || '',
    disabled: false,
    provider: normalizeText(transport && transport.provider, 64) || kind,
    routeRole: normalizeText(transport && transport.routeRole, 64) || 'data-plane',
    trustLevel: normalizeText(transport && transport.trustLevel, 64) || (kind === 'relay' ? 'managed' : 'manual'),
    promotion: transport && transport.promotion && typeof transport.promotion === 'object' ? { ...transport.promotion } : null,
    measurement
  };
}

function redactTransport(transport, measurements = []) {
  const selectorTransport = toSelectorTransport(transport, measurements);
  const metadata = getTransportKindMetadata(transport && transport.kind) || {};
  return {
    id: normalizeId(transport && transport.id),
    kind: normalizeText(transport && transport.kind, 64),
    label: metadata.label || normalizeText(transport && transport.kind, 64),
    nodeId: normalizeId(transport && transport.nodeId),
    lane: metadata.lane || '',
    routeRole: normalizeText(transport && transport.routeRole, 64) || 'data-plane',
    endpointMode: metadata.endpointMode || '',
    status: selectorTransport ? selectorTransport.status : statusFromHealth(transport && (transport.health || transport.status)),
    measured: Boolean(selectorTransport && selectorTransport.measurement),
    measurement: selectorTransport && selectorTransport.measurement ? selectorTransport.measurement : null
  };
}

function advancedBlockers(kind, candidateTransports, evaluated = []) {
  if (!candidateTransports.length) {
    if (kind === 'webrtc') return ['webrtc_transport_candidate_not_registered', 'turn_relay_gate_not_ready'];
    if (kind === 'webtransport') return ['webtransport_h3_endpoint_missing'];
    if (kind === 'omr') return ['openmptcprouter_not_detected'];
    if (kind === 'mptcp') return ['mptcp_data_plane_not_promoted'];
    return ['transport_candidate_not_registered'];
  }
  const rejectedReasons = evaluated
    .filter((item) => item.transport && item.transport.kind === kind && !item.eligible)
    .map((item) => item.reason)
    .filter(Boolean);
  const blockers = rejectedReasons.length ? rejectedReasons : [];
  if (kind === 'webrtc'
    && blockers.includes('webrtc_not_promoted')
    && !blockers.includes('turn_relay_gate_not_ready')) {
    blockers.push('turn_relay_gate_not_ready');
  }
  if (kind === 'webtransport') return canonicalizeWebTransportBlockers(blockers, candidateTransports);
  if (kind === 'omr' && !blockers.includes('openmptcprouter_underlay_not_promoted')) blockers.push('openmptcprouter_underlay_not_promoted');
  if (kind === 'mptcp' && !blockers.includes('mptcp_data_plane_not_promoted')) blockers.push('mptcp_data_plane_not_promoted');
  return Array.from(new Set(blockers));
}

function canonicalizeWebTransportBlockers(blockers = [], candidateTransports = []) {
  const output = [];
  let needsH3Endpoint = false;

  Array.from(new Set((Array.isArray(blockers) ? blockers : [])
    .map((blocker) => normalizeText(blocker, 160))
    .filter(Boolean))).forEach((blocker) => {
    if (/^webtransport_(endpoint_not_configured|not_promoted|h3_endpoint_missing)$/.test(blocker)
      || blocker === 'missing_endpoint') {
      needsH3Endpoint = true;
      return;
    }
    output.push(blocker);
  });

  candidateTransports.forEach((transport) => {
    const lastError = normalizeText(transport && transport.lastError, 160);
    if (lastError && /^webtransport_/.test(lastError)) output.push(lastError);
  });

  if (needsH3Endpoint || output.length === 0) output.unshift('webtransport_h3_endpoint_missing');
  return Array.from(new Set(output));
}

function buildAdvancedReadiness(kind, nodeTransports, evaluated) {
  const metadata = getTransportKindMetadata(kind) || {};
  const candidates = nodeTransports.filter((transport) => normalizeText(transport.kind, 64) === kind);
  const eligible = evaluated.filter((item) => item.transport && item.transport.kind === kind && item.eligible);
  return {
    kind,
    label: metadata.label || kind,
    candidateReady: candidates.length > 0,
    promotionReady: eligible.length > 0,
    candidates: candidates.map((transport) => normalizeId(transport.id)).filter(Boolean),
    blockers: advancedBlockers(kind, candidates, evaluated)
  };
}

function buildRelayFallbackReadiness(decision, nodeTransports, measurements) {
  const selectedId = normalizeId(decision && decision.selectedTransportId);
  const relayCandidates = nodeTransports
    .filter((transport) => normalizeText(transport && transport.kind, 64) === 'relay')
    .map((transport) => ({
      transport,
      id: normalizeId(transport && transport.id),
      status: statusFromHealth(transport && (transport.health || transport.status)),
      measurement: latestMeasurementForTransport(transport, measurements)
    }))
    .sort((left, right) => {
      const leftSelected = left.id === selectedId ? 1 : 0;
      const rightSelected = right.id === selectedId ? 1 : 0;
      if (leftSelected !== rightSelected) return rightSelected - leftSelected;
      const leftMeasured = measurementPasses(left.measurement) ? 1 : 0;
      const rightMeasured = measurementPasses(right.measurement) ? 1 : 0;
      if (leftMeasured !== rightMeasured) return rightMeasured - leftMeasured;
      return Number(right.measurement && right.measurement.measuredAt || 0) - Number(left.measurement && left.measurement.measuredAt || 0);
    });
  const selected = relayCandidates[0] || null;
  const selectedKind = normalizeText(decision && decision.selectedKind, 64);
  const measurement = selected ? selected.measurement : null;
  const relayStatusReady = selected && (selected.status === 'up' || selected.status === 'degraded');
  const relayMeasurementReady = measurementPasses(measurement);
  return {
    ready: Boolean(selected && (selectedKind === 'relay' || relayStatusReady || relayMeasurementReady)),
    selectedTransportId: selected ? selected.id : '',
    measured: Boolean(measurement),
    measurementPass: measurementPasses(measurement),
    measurement
  };
}

function buildNodeTransportReadiness(node, registry, options = {}) {
  const purpose = normalizePurpose(options.purpose);
  const allTransports = Array.isArray(registry && registry.transports) ? registry.transports : [];
  const nodeTransports = allTransports.filter((transport) => normalizeId(transport && transport.nodeId) === normalizeId(node && node.id));
  const selectorTransports = nodeTransports
    .map((transport) => toSelectorTransport(transport, registry.networkMeasurements))
    .filter(Boolean)
    .map((transport) => {
      const adapters = normalizeAdapterList(options.availableAdapters);
      if (transport.kind !== 'webrtc' || !adapters.has('webrtc')) return transport;
      return {
        ...transport,
        endpoint: transport.endpoint || `webrtc-session://${normalizeId(node && node.id)}`,
        status: 'up',
        score: Math.max(Number(transport.score) || 0, 90),
        lastError: ''
      };
    });
  const selectorNode = {
    id: normalizeId(node && node.id),
    preferredTransports: node && Array.isArray(node.preferredTransports) ? node.preferredTransports : []
  };
  const decision = selectTransportDecision(selectorNode, selectorTransports, {
    purpose,
    availableAdapters: options.availableAdapters
  });
  const evaluated = selectorTransports.map((transport) => ({
    transport,
    eligible: !decision.rejected.some((item) => item.id === transport.id),
    reason: (decision.rejected.find((item) => item.id === transport.id) || {}).reason || ''
  }));
  const relayFallback = buildRelayFallbackReadiness(decision, nodeTransports, registry.networkMeasurements);
  const advanced = ADVANCED_TRANSPORT_KINDS.map((kind) => buildAdvancedReadiness(kind, selectorTransports, evaluated));
  return {
    node: {
      id: normalizeId(node && node.id),
      name: normalizeText(node && node.name, 120),
      status: normalizeText(node && node.status, 32),
      roles: Array.isArray(node && node.roles) ? node.roles : []
    },
    purpose,
    defaultTransport: decision.selectedKind || 'none',
    fallbackReady: relayFallback.ready,
    relayFallback,
    decision: {
      selectedTransportId: decision.selectedTransportId,
      selectedKind: decision.selectedKind || 'none',
      fallbackUsed: decision.fallbackUsed,
      fallbackFrom: decision.fallbackFrom,
      rejected: decision.rejected
    },
    transports: nodeTransports.map((transport) => redactTransport(transport, registry.networkMeasurements)),
    advanced
  };
}

function buildTransportReadinessReport(registryInput = {}, options = {}) {
  const registry = registryInput && typeof registryInput === 'object' ? registryInput : {};
  const nodeId = normalizeId(options.nodeId);
  const nodes = (Array.isArray(registry.nodes) ? registry.nodes : [])
    .filter((node) => !nodeId || normalizeId(node && node.id) === nodeId)
    .map((node) => buildNodeTransportReadiness(node, registry, options));
  const promoted = new Set();
  const blockers = new Set();
  nodes.forEach((node) => {
    node.advanced.forEach((gate) => {
      if (gate.promotionReady) promoted.add(gate.kind);
      else gate.blockers.forEach((blocker) => blockers.add(`${gate.kind}:${blocker}`));
    });
  });
  const fallbackReady = nodes.some((node) => node.fallbackReady);
  const selectedKinds = Array.from(new Set(nodes.map((node) => node.defaultTransport).filter(Boolean)));
  return {
    generatedAt: new Date().toISOString(),
    purpose: normalizePurpose(options.purpose),
    nodeId: nodeId || '',
    summary: {
      nodes: nodes.length,
      defaultTransports: selectedKinds,
      defaultTransport: promoted.size > 0 ? Array.from(promoted)[0] : (fallbackReady ? 'relay' : (selectedKinds[0] || 'none')),
      fallbackReady,
      promotionReady: promoted.size > 0,
      promotedTransports: Array.from(promoted),
      blockers: Array.from(blockers)
    },
    inventory: buildFabricNodeInventory(registry),
    nodes
  };
}

module.exports = {
  ADVANCED_TRANSPORT_KINDS,
  buildTransportReadinessReport,
  canonicalizeWebTransportBlockers,
  statusFromHealth,
  toSelectorTransport
};
