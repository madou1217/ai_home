'use strict';

const {
  deleteJsonValue,
  readJsonValuesByPrefix,
  writeJsonValue
} = require('./app-state-store');
const {
  SCOPES,
  classifyLegacyEvidence,
  evidenceKey,
  normalizeEvidenceRecord
} = require('./egress-evidence-scope');

const EVIDENCE_KEY_PREFIX = 'egress:evidence:';
const DEFAULT_MAX_RECORDS = 4000;

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value || '').trim();
}

function clone(value) {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = clone(item);
    return result;
  }
  return value;
}

function createEgressEvidenceStore(options = {}) {
  const fs = options.fs || null;
  const aiHomeDir = text(options.aiHomeDir);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxRecords = Number(options.maxRecords) > 0 ? Number(options.maxRecords) : DEFAULT_MAX_RECORDS;
  const records = new Map();

  if (fs && aiHomeDir) {
    try {
      for (const [key, raw] of readJsonValuesByPrefix(fs, aiHomeDir, EVIDENCE_KEY_PREFIX)) {
        const record = normalizeEvidenceRecord(raw);
        if (record) records.set(key.slice(EVIDENCE_KEY_PREFIX.length), record);
      }
    } catch (_error) {
      // A damaged evidence file is treated as empty. Compatibility readers
      // still retain access to the older upstream-evidence namespace.
    }
  }

  function persist(key, record) {
    if (!fs || !aiHomeDir) return true;
    return writeJsonValue(fs, aiHomeDir, `${EVIDENCE_KEY_PREFIX}${key}`, record);
  }

  function trim() {
    if (records.size <= maxRecords) return;
    const entries = [...records.entries()].sort((a, b) => Number(a[1].at) - Number(b[1].at));
    entries.slice(0, entries.length - maxRecords).forEach(([key]) => {
      records.delete(key);
      if (fs && aiHomeDir) deleteJsonValue(fs, aiHomeDir, `${EVIDENCE_KEY_PREFIX}${key}`);
    });
  }

  // Bound the loaded projection as well as new writes. This also removes
  // evicted keys from persisted app state before callers can observe them.
  trim();

  function recordEvidence(raw) {
    const input = raw && typeof raw === 'object' ? { ...raw } : {};
    if (!input.at) input.at = now();
    const record = normalizeEvidenceRecord(input);
    if (!record) return { accepted: false, reason: 'invalid_scoped_evidence' };
    const key = evidenceKey(record) || `legacy:${record.at}:${records.size}`;
    const quarantined = record.scope === SCOPES.LEGACY;
    records.set(key, { ...record, key });
    trim();
    if (!persist(key, records.get(key))) return { accepted: false, reason: 'evidence_write_failed' };
    return {
      accepted: true,
      reason: quarantined ? 'legacy_unscoped_evidence' : 'recorded',
      record: clone(records.get(key))
    };
  }

  function listEvidence(query = {}) {
    const includeLegacy = query.includeLegacy === true;
    const scope = query.scope ? text(query.scope).toLowerCase() : '';
    const matches = (record) => {
      if (!includeLegacy && record.scope === SCOPES.LEGACY) return false;
      if (scope && record.scope !== scope) return false;
      const exact = [
        ['accountRef', query.accountRef],
        ['provider', query.provider],
        ['upstreamId', query.upstreamId || query.upstream],
        ['nodeId', query.nodeId || query.node],
        ['exitIp', query.exitIp || query.ip],
        ['modelFamily', query.modelFamily || query.model],
        ['credentialGeneration', query.credentialGeneration]
      ];
      return exact.every(([key, value]) => value === undefined || value === null || value === ''
        || text(record[key]).toLowerCase() === text(value).toLowerCase());
    };
    return [...records.values()].filter(matches).sort((a, b) => Number(a.at) - Number(b.at)).map(clone);
  }

  return { recordEvidence, listEvidence, classifyLegacyEvidence };
}

// The server composition root normally injects a store instance. These small
// convenience exports keep the domain interface usable by compatibility code
// and focused callers that do not need persistence configuration.
const defaultStore = createEgressEvidenceStore();
function recordEvidence(record) {
  return defaultStore.recordEvidence(record);
}
function listEvidence(query) {
  return defaultStore.listEvidence(query);
}

module.exports = {
  DEFAULT_MAX_RECORDS,
  EVIDENCE_KEY_PREFIX,
  createEgressEvidenceStore,
  listEvidence,
  recordEvidence
};
