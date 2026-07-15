'use strict';

function normalizeText(value, maxLength = 256) {
  const text = String(value || '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeStringArray(value, maxItems = 16, maxLength = 96) {
  return (Array.isArray(value) ? value : [])
    .map((item) => normalizeText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeRejectedTransports(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      id: normalizeText(item && item.id, 96),
      kind: normalizeText(item && item.kind, 64),
      reason: normalizeText(item && item.reason, 160)
    }))
    .filter((item) => item.id || item.kind || item.reason)
    .slice(0, 8);
}

function normalizeTransportDecision(value) {
  const source = value && typeof value === 'object' ? value : null;
  if (!source) return null;
  const decision = {
    transportPurpose: normalizeText(source.transportPurpose, 64),
    selectedTransportId: normalizeText(source.selectedTransportId, 96),
    selectedTransportKind: normalizeText(source.selectedTransportKind, 64),
    fallbackUsed: Boolean(source.fallbackUsed),
    fallbackFrom: normalizeStringArray(source.fallbackFrom),
    rejectedTransports: normalizeRejectedTransports(source.rejectedTransports)
  };
  if (!decision.transportPurpose
    && !decision.selectedTransportId
    && !decision.selectedTransportKind
    && !decision.fallbackUsed
    && decision.fallbackFrom.length === 0
    && decision.rejectedTransports.length === 0) {
    return null;
  }
  return decision;
}

function normalizeTransport(value) {
  const source = value && typeof value === 'object' ? value : null;
  if (!source) return null;
  const transport = {
    id: normalizeText(source.id, 96),
    kind: normalizeText(source.kind, 64)
  };
  return transport.id || transport.kind ? transport : null;
}

function normalizeTransportEvidence(value) {
  const source = value && typeof value === 'object' ? value : {};
  const evidence = {};
  const transport = normalizeTransport(source.transport);
  const decision = normalizeTransportDecision(source.transportDecision);
  if (transport) evidence.transport = transport;
  if (decision) evidence.transportDecision = decision;
  return evidence;
}

function appendTransportEvidenceLines(lines, report = {}) {
  const transport = report.transport && typeof report.transport === 'object' ? report.transport : null;
  const decision = report.transportDecision && typeof report.transportDecision === 'object'
    ? report.transportDecision
    : null;
  const kind = normalizeText(transport && transport.kind, 64)
    || normalizeText(decision && decision.selectedTransportKind, 64);
  const id = normalizeText(transport && transport.id, 96)
    || normalizeText(decision && decision.selectedTransportId, 96);
  if (!kind && !id && !decision) return;
  lines.push(`  transport: kind=${kind || ''} id=${id || ''}`);
  if (decision) {
    const fallback = decision.fallbackUsed ? 'yes' : 'no';
    lines.push(`  transport_decision: purpose=${decision.transportPurpose || ''} fallback=${fallback}`);
    if (decision.fallbackFrom && decision.fallbackFrom.length > 0) {
      lines.push(`  fallback_from: ${decision.fallbackFrom.join(', ')}`);
    }
  }
}

module.exports = {
  appendTransportEvidenceLines,
  normalizeTransportEvidence
};
