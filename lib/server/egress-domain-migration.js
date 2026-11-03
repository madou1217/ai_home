'use strict';

// Migration boundary for the egress domain.  The planner is intentionally a
// read-only projection: it discovers old records, normalizes what can be
// proven, and records warnings for evidence or identities that cannot safely be
// promoted.  Apply writes a journal before the first entity and keeps every
// legacy key intact.  Rollback replays the journal in reverse.

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');

const {
  openAppStateDatabase,
  readJsonValuesByPrefix
} = require('./app-state-store');
const {
  normalizeAccountEgressAssignment,
  normalizeNodeEntity
} = require('./egress-domain-contract');
const {
  SCOPES,
  classifyLegacyEvidence,
  evidenceKey,
  normalizeEvidenceRecord
} = require('./egress-evidence-scope');

const LEGACY_BINDING_PREFIXES = Object.freeze(['account:egress:', 'account-egress-binding:']);
const LEGACY_EVIDENCE_PREFIX = 'egress:upstream-evidence:';
const DOMAIN_EVIDENCE_PREFIX = 'egress:evidence:';
const NODE_HEALTH_FILE = ['run', 'egress-pool', 'node-health.json'];

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value || '').trim();
}

function clone(value) {
  if (value === undefined || value === null) return value;
  if (Array.isArray(value)) return value.map(clone);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function migrationId() {
  return crypto.randomUUID();
}

function accountRefFromKey(key, prefix) {
  const ref = text(String(key || '').slice(prefix.length));
  return /^acct_[a-z0-9]{20,}$/i.test(ref) ? ref : '';
}

function domainKey(kind, id) {
  const prefix = kind === 'assignment' ? 'egress:entity:assignment:'
    : (kind === 'node' ? 'egress:entity:node:' : DOMAIN_EVIDENCE_PREFIX);
  return `${prefix}${id}`;
}

function readLegacyBindings(fs, aiHomeDir) {
  const result = [];
  for (const prefix of LEGACY_BINDING_PREFIXES) {
    for (const [key, value] of readJsonValuesByPrefix(fs, aiHomeDir, prefix, { strict: true })) {
      const accountRef = accountRefFromKey(key, prefix);
      if (accountRef) result.push({ accountRef, key, value: value && typeof value === 'object' ? value : {} });
    }
  }
  const seen = new Set();
  return result.filter((entry) => {
    if (seen.has(entry.accountRef)) return false;
    seen.add(entry.accountRef);
    return true;
  });
}

function readNodeHealth(fs, aiHomeDir, pathImpl = nodePath) {
  if (!fs || typeof fs.readFileSync !== 'function' || !aiHomeDir) return { nodes: [], warnings: [] };
  const file = pathImpl.join(aiHomeDir, ...NODE_HEALTH_FILE);
  let document;
  try { document = JSON.parse(String(fs.readFileSync(file, 'utf8'))); } catch (_error) { return { nodes: [], warnings: [] }; }
  const nodes = [];
  const legacyEvidence = [];
  const warnings = [];
  for (const [identity, stats] of Object.entries(document && document.nodes || {})) {
    const parts = text(identity).split('|');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !/^\d+$/.test(parts[2])) {
      warnings.push({ code: 'ambiguous_node_identity', identity, source: 'node-health' });
      continue;
    }
    try {
      const node = normalizeNodeEntity({ protocol: parts[0], server: parts[1], port: Number(parts[2]), source: 'legacy-node-health' });
      nodes.push({ node, legacyIdentity: identity, stats: clone(stats) });
      if (stats && (stats.cooldownKind === 'ip_blocked' || stats.legacyCooldownKind === 'ip_blocked')) {
        legacyEvidence.push(classifyLegacyEvidence({
          status: 'blocked', source: 'legacy', reason: 'ip_blocked',
          nodeId: node.nodeId, at: Number(stats.lastFailureAt || stats.legacyCooldownUntil || stats.cooldownUntil) || Date.now(),
          key: `legacy:node-health:${identity}`
        }));
      }
    } catch (_error) {
      warnings.push({ code: 'ambiguous_node_identity', identity, source: 'node-health' });
    }
  }
  return { nodes, warnings, legacyEvidence };
}

function readLegacyEvidence(fs, aiHomeDir) {
  const records = [];
  for (const [key, document] of readJsonValuesByPrefix(fs, aiHomeDir, LEGACY_EVIDENCE_PREFIX, { strict: true })) {
    const upstreamId = text(key.slice(LEGACY_EVIDENCE_PREFIX.length)).toLowerCase();
    if (!document || typeof document !== 'object') continue;
    const entries = document.status ? [['legacy', document]] : Object.entries(document);
    for (const [exitKey, value] of entries) {
      if (!value || typeof value !== 'object') continue;
      const raw = { ...value, upstreamId: value.upstreamId || upstreamId, key: value.key || exitKey };
      const scoped = raw.scope && raw.provider && (raw.accountRef || raw.scope === SCOPES.PROVIDER_EXIT)
        ? normalizeEvidenceRecord(raw)
        : classifyLegacyEvidence(raw);
      if (scoped) {
        if (scoped.scope === SCOPES.LEGACY) scoped.key = `legacy:${upstreamId}:${exitKey}`;
        records.push(scoped);
      }
    }
  }
  return records;
}

function planEgressMigration(options = {}) {
  const fs = options.fs || nodeFs;
  const aiHomeDir = text(options.aiHomeDir);
  const id = text(options.migrationId) || migrationId();
  const pathImpl = options.path || nodePath;
  const bindings = readLegacyBindings(fs, aiHomeDir);
  const health = readNodeHealth(fs, aiHomeDir, pathImpl);
  const legacyEvidence = [...(health.legacyEvidence || []), ...readLegacyEvidence(fs, aiHomeDir)];
  const operations = [];
  const warnings = [...health.warnings];

  for (const entry of bindings) {
    try {
      const value = entry.value;
      // Only pool bindings represent assignments. Direct, URL, system, TUN,
      // and retired bindings must retain their existing meaning.
      if (text(value.mode).toLowerCase() !== 'pool' || value.retired) continue;
      const sourceScope = value.scope || { kind: 'all' };
      const legacyNodes = Array.isArray(sourceScope.nodes || sourceScope.nodeIds)
        ? (sourceScope.nodes || sourceScope.nodeIds) : [];
      const unresolvedRuntimeNodes = legacyNodes.filter((node) => /^node-\d+$/i.test(text(node)));
      if (unresolvedRuntimeNodes.length > 0) {
        warnings.push({ code: 'ambiguous_node_identity', accountRef: entry.accountRef, identities: unresolvedRuntimeNodes.slice(), source: entry.key });
        continue;
      }
      const assignment = normalizeAccountEgressAssignment({
        ...value,
        accountRef: entry.accountRef,
        scope: sourceScope,
        selectionMode: value.selectionMode || 'auto',
        strategy: value.strategy || 'shared'
      });
      operations.push({
        kind: 'assignment', accountRef: entry.accountRef,
        legacyKey: entry.key, key: domainKey('assignment', entry.accountRef),
        value: assignment
      });
    } catch (error) {
      warnings.push({ code: 'legacy_binding_unmigratable', accountRef: entry.accountRef, reason: error.code || error.message });
    }
  }
  for (const entry of health.nodes) {
    operations.push({
      kind: 'node', nodeId: entry.node.nodeId, legacyIdentity: entry.legacyIdentity,
      key: domainKey('node', entry.node.nodeId), value: entry.node, stats: entry.stats
    });
  }
  for (const record of legacyEvidence) {
    const normalized = record.scope === SCOPES.LEGACY ? record : normalizeEvidenceRecord(record);
    if (!normalized) continue;
    const key = evidenceKey(normalized) || `legacy:${normalized.at || Date.now()}:${operations.length}`;
    operations.push({
      kind: 'evidence', key: `${DOMAIN_EVIDENCE_PREFIX}${key}`,
      value: { ...normalized, key },
      legacy: normalized.scope === SCOPES.LEGACY
    });
  }
  const ambiguousNodeIdentity = warnings.filter((warning) => warning.code === 'ambiguous_node_identity');
  return {
    kind: 'egress-domain-migration', version: 1, migrationId: id,
    generatedAt: Date.now(), aiHomeDir,
    operations,
    assignments: operations.filter((op) => op.kind === 'assignment').map((op) => clone(op.value)),
    nodes: operations.filter((op) => op.kind === 'node').map((op) => clone(op.value)),
    legacyEvidence: legacyEvidence.map(clone),
    warnings,
    ambiguousNodeIdentity,
    blockers: warnings.filter((warning) => warning.code === 'legacy_binding_unmigratable'
      || (warning.code === 'ambiguous_node_identity' && warning.accountRef)),
    oldRecords: bindings.map((entry) => ({ key: entry.key, accountRef: entry.accountRef, value: clone(entry.value) })),
    verification: {
      oldRecordsRetained: true,
      legacyEvidenceNonBlocking: legacyEvidence.every((entry) => entry.scope !== SCOPES.LEGACY || entry.usableForBlocking === false),
      stableNodeIdentityCount: operations.filter((op) => op.kind === 'node').length
    }
  };
}

function journalPath(aiHomeDir, id, pathImpl = nodePath) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('invalid_migration_id');
  return pathImpl.join(aiHomeDir, 'migration', `egress-domain-${id}`, 'journal.json');
}

function writeJournal(fs, file, journal) {
  if (!fs || typeof fs.writeFileSync !== 'function') return false;
  const directory = nodePath.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600, flag: 'w' });
  if (typeof fs.chmodSync === 'function') fs.chmodSync(temporary, 0o600);
  if (typeof fs.renameSync === 'function') fs.renameSync(temporary, file);
  else fs.writeFileSync(file, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  return true;
}

function readJournal(fs, file) {
  try { return JSON.parse(String(fs.readFileSync(file, 'utf8'))); } catch (_error) { return null; }
}

function applyEgressMigration(options = {}) {
  const fs = options.fs || nodeFs;
  const aiHomeDir = text(options.aiHomeDir);
  const plan = options.plan || planEgressMigration({ ...options, fs, aiHomeDir });
  if (!aiHomeDir || plan.aiHomeDir !== aiHomeDir) throw new Error('migration_home_mismatch');
  if (options.dryRun === true) return { applied: false, dryRun: true, migrationId: plan.migrationId, plan };
  if (plan.blockers.length > 0) return { applied: false, dryRun: false, migrationId: plan.migrationId, plan, reason: 'migration_blocked', blockers: plan.blockers };
  const file = journalPath(aiHomeDir, plan.migrationId, options.path || nodePath);
  if (fs.existsSync(file)) return { applied: false, migrationId: plan.migrationId, journalPath: file, reason: 'migration_journal_exists' };
  const journal = {
    kind: 'egress-domain-migration-journal', version: 1, migrationId: plan.migrationId,
    state: 'pending', createdAt: Date.now(), journalPath: file, operations: []
  };
  let db;
  try {
    db = openAppStateDatabase(fs, aiHomeDir);
    if (!db) throw new Error('egress_migration_database_unavailable');
    db.exec('BEGIN IMMEDIATE');
    const read = db.prepare('SELECT value FROM app_kv WHERE key = ?');
    const put = db.prepare('INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
    for (const source of plan.oldRecords) {
      const row = read.get(source.key);
      if (!row || JSON.stringify(JSON.parse(row.value)) !== JSON.stringify(source.value)) throw new Error('migration_source_changed');
    }
    for (const operation of plan.operations) {
      const row = read.get(operation.key);
      journal.operations.push({ key: operation.key, kind: operation.kind, hadPrevious: Boolean(row),
        previous: row ? JSON.parse(row.value) : null, next: clone(operation.value), state: 'started' });
      put.run(operation.key, JSON.stringify(operation.value), Date.now());
    }
    // Publish the complete recovery journal before the transaction can commit.
    journal.state = 'started';
    writeJournal(fs, file, journal);
    db.exec('COMMIT');
    journal.state = 'applied';
    journal.completedAt = Date.now();
    writeJournal(fs, file, journal);
    return { applied: true, dryRun: false, migrationId: plan.migrationId, journalPath: file,
      plan, journal, verification: { oldRecordsRetained: true, operations: journal.operations.length } };
  } catch (error) {
    if (db) { try { db.exec('ROLLBACK'); } catch (_error) {} }
    return { applied: false, dryRun: false, migrationId: plan.migrationId, journalPath: file,
      plan, journal, error: String(error && error.code || error && error.message || error) };
  } finally {
    if (db) db.close();
  }
}

function rollbackEgressMigration(options = {}) {
  const fs = options.fs || nodeFs;
  const aiHomeDir = text(options.aiHomeDir);
  const id = text(options.migrationId);
  if (!id) return { rolledBack: false, reason: 'migration_id_required' };
  const file = journalPath(aiHomeDir, id, options.path || nodePath);
  const journal = readJournal(fs, file);
  if (!journal) return { rolledBack: false, migrationId: id, journalPath: file, reason: 'migration_not_found' };
  if (journal.state === 'rolled_back') return { rolledBack: true, migrationId: id, journalPath: file, journal };
  if (journal.kind !== 'egress-domain-migration-journal' || journal.version !== 1
    || journal.migrationId !== id || !['started', 'applied', 'rollback_started'].includes(journal.state)
    || !Array.isArray(journal.operations)
    || journal.operations.some((operation) => !operation || typeof operation.key !== 'string'
      || !['egress:entity:assignment:', 'egress:entity:node:', DOMAIN_EVIDENCE_PREFIX].some((prefix) => operation.key.startsWith(prefix))
      || !Object.hasOwn(operation, 'next') || !Object.hasOwn(operation, 'previous')
      || typeof operation.hadPrevious !== 'boolean')) {
    return { rolledBack: false, migrationId: id, journalPath: file, reason: 'invalid_migration_journal' };
  }
  let db;
  try {
    db = openAppStateDatabase(fs, aiHomeDir, { createIfMissing: false });
    if (!db) throw new Error('egress_migration_database_unavailable');
    db.exec('BEGIN IMMEDIATE');
    const read = db.prepare('SELECT value FROM app_kv WHERE key = ?');
    const put = db.prepare('INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
    const remove = db.prepare('DELETE FROM app_kv WHERE key = ?');
    const expected = new Map();
    for (const operation of (journal.operations || []).slice().reverse()) {
      const row = expected.has(operation.key) ? null : read.get(operation.key);
      const current = expected.has(operation.key) ? expected.get(operation.key) : (row ? JSON.parse(row.value) : null);
      if (JSON.stringify(current) !== JSON.stringify(operation.next)
        && !(['started', 'rollback_started'].includes(journal.state)
          && JSON.stringify(current) === JSON.stringify(operation.previous))) {
        db.exec('ROLLBACK');
        return { rolledBack: false, migrationId: id, journalPath: file, reason: 'migration_rollback_conflict', key: operation.key };
      }
      expected.set(operation.key, operation.hadPrevious ? operation.previous : null);
    }
    for (const operation of (journal.operations || []).slice().reverse()) {
      if (operation.hadPrevious) put.run(operation.key, JSON.stringify(operation.previous), Date.now());
      else remove.run(operation.key);
    }
    journal.state = 'rollback_started';
    writeJournal(fs, file, journal);
    db.exec('COMMIT');
    journal.state = 'rolled_back';
    journal.rolledBackAt = Date.now();
    writeJournal(fs, file, journal);
    return { rolledBack: true, migrationId: id, journalPath: file, journal };
  } catch (error) {
    if (db) { try { db.exec('ROLLBACK'); } catch (_error) {} }
    return { rolledBack: false, migrationId: id, journalPath: file, journal, error: String(error && error.code || error && error.message || error) };
  } finally {
    if (db) db.close();
  }
}

module.exports = {
  applyEgressMigration,
  classifyLegacyEvidence,
  planEgressMigration,
  rollbackEgressMigration
};
