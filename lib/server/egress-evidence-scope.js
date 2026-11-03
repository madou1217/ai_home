'use strict';

// Evidence is deliberately keyed by the identity that was tested.  A node or
// exit IP is a shared resource, but its regional behaviour can differ by
// provider, upstream, model, account, and credential generation.  Keeping the
// scope in both the key and the record prevents an old node-only blacklist from
// silently becoming a global policy.

const SCOPES = Object.freeze({
  PROVIDER_EXIT: 'provider_upstream_exit',
  ACCOUNT_UPSTREAM: 'account_upstream_exit',
  LEGACY: 'legacy_unscoped_evidence'
});

const SOURCES = new Set(['probe', 'traffic', 'credentialed', 'manual', 'legacy']);
const STATUSES = new Set(['ok', 'blocked', 'reachable']);
const CONFIDENCE_LABELS = new Set(['low', 'medium', 'high', 'unknown', 'account_specific', 'provider_consistent']);

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value || '').trim();
}

function field(value, lower = false) {
  const result = text(value);
  return lower ? result.toLowerCase() : result;
}

function keyPart(value) {
  return encodeURIComponent(text(value));
}

function buildProviderExitEvidenceKey(input = {}) {
  return [
    'provider', field(input.provider, true),
    'upstream', field(input.upstreamId, true),
    'node', field(input.nodeId),
    'ip', field(input.exitIp),
    'model', field(input.modelFamily, true)
  ].map(keyPart).join('|');
}

function buildAccountUpstreamEvidenceKey(input = {}) {
  const generation = input.credentialGeneration === undefined || input.credentialGeneration === null
    ? '' : text(input.credentialGeneration);
  return [
    'account', field(input.accountRef),
    'provider', field(input.provider, true),
    'upstream', field(input.upstreamId, true),
    'node', field(input.nodeId),
    'ip', field(input.exitIp),
    'model', field(input.modelFamily, true),
    'credential', generation
  ].map(keyPart).join('|');
}

function normalizeScope(value) {
  const scope = text(value).toLowerCase();
  if (scope === SCOPES.PROVIDER_EXIT || scope === 'provider_exit') return SCOPES.PROVIDER_EXIT;
  if (scope === SCOPES.ACCOUNT_UPSTREAM || scope === 'account_upstream') return SCOPES.ACCOUNT_UPSTREAM;
  return SCOPES.LEGACY;
}

function classifyLegacyEvidence(record) {
  const source = record && typeof record === 'object' ? record : {};
  return {
    ...source,
    scope: SCOPES.LEGACY,
    source: SOURCES.has(source.source) ? source.source : 'legacy',
    usableForBlocking: false,
    reason: text(source.reason) || 'legacy_unscoped_evidence'
  };
}

function normalizeEvidenceRecord(record = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const scope = normalizeScope(record.scope);
  const at = Number(record.at || record.timestamp) || Date.now();
  const normalized = {
    ...record,
    scope,
    provider: field(record.provider, true),
    upstreamId: field(record.upstreamId || record.upstream, true),
    nodeId: field(record.nodeId || record.node || record.identity),
    exitIp: field(record.exitIp || record.ip),
    modelFamily: field(record.modelFamily || record.model, true),
    accountRef: field(record.accountRef),
    credentialGeneration: record.credentialGeneration === undefined || record.credentialGeneration === null
      ? undefined : text(record.credentialGeneration),
    status: STATUSES.has(record.status) ? record.status : '',
    source: SOURCES.has(record.source) ? record.source : 'probe',
    at,
    timestamp: at,
    confidence: Number.isFinite(Number(record.confidence))
      ? Math.max(0, Math.min(1, Number(record.confidence)))
      : (CONFIDENCE_LABELS.has(text(record.confidence)) ? text(record.confidence) : 'unknown'),
    usableForBlocking: scope !== SCOPES.LEGACY
  };
  if (scope === SCOPES.LEGACY) return classifyLegacyEvidence(normalized);
  if (!normalized.provider || !normalized.upstreamId || !normalized.status) return null;
  if (scope === SCOPES.ACCOUNT_UPSTREAM && !normalized.accountRef) return null;
  return normalized;
}

function evidenceKey(record) {
  if (!record || typeof record !== 'object') return '';
  if (record.scope === SCOPES.ACCOUNT_UPSTREAM) return buildAccountUpstreamEvidenceKey(record);
  if (record.scope === SCOPES.PROVIDER_EXIT) return buildProviderExitEvidenceKey(record);
  return text(record.key);
}

module.exports = {
  SCOPES,
  SOURCES,
  STATUSES,
  CONFIDENCE_LABELS,
  buildAccountUpstreamEvidenceKey,
  buildProviderExitEvidenceKey,
  classifyLegacyEvidence,
  evidenceKey,
  normalizeEvidenceRecord,
  normalizeScope
};
