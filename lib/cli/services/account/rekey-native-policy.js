'use strict';

const path = require('node:path');
const { quote, tablesAndColumns } = require('./codex-rekey-storage');
const { databaseFingerprint, sha256 } = require('./rekey-database');
const { containsMappedRef, referenceNeedles, replaceAccountPathSegments } = require('./codex-rekey-reference-policy');

// Versioned vendor databases are adapters, not AIH account tables. No schema,
// migration version, thread identity, prompt, tool result or log text is rewritten.
const PATH_COLUMNS = new Set([
  'threads.rollout_path', 'rollout_migration_skipped_rollouts.rollout_path'
]);
const HISTORY_COLUMNS = new Set([
  'threads.title', 'threads.first_user_message', 'threads.preview',
  'logs.feedback_log_body', 'logs.file', 'logs.module_path', 'logs.target'
]);

function nativeStoreKind(relative) {
  const normalized = relative.split(path.sep).join('/');
  const match = /(?:^|\/)\.codex\/(state|logs)_\d+\.sqlite$/.exec(normalized);
  return match ? match[1] : '';
}

function isNativeSidecar(relative) {
  return /-(wal|shm|journal)$/.test(relative) && !!nativeStoreKind(relative.replace(/-(wal|shm|journal)$/, ''));
}

/** Include native sequence counters and schema header facts in the post-state. */
function nativeFingerprint(db, changes = []) {
  const base = databaseFingerprint(db, changes);
  let sequences = [];
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()) {
    const statement = db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name');
    statement.setReadBigInts(true);
    sequences = statement.all().map(row => [row.name, String(row.seq)]);
  }
  const header = { userVersion: db.prepare('PRAGMA user_version').get().user_version,
    applicationId: db.prepare('PRAGMA application_id').get().application_id };
  return { digest: sha256(JSON.stringify([base.digest, sequences, header])), counts: base.counts };
}

/**
 * Only native rollout addressing is an update policy. Other occurrences must
 * either be documented immutable history or become blockers, including BLOBs
 * and executable schema SQL. New vendor columns are not silently blessed.
 */
function planNativeReferences(db, mapping, kind) {
  const changes = [], blockers = [], immutable = [];
  const refs = referenceNeedles(mapping);
  for (const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL").all()) {
    if (containsMappedRef(row.sql, mapping)) blockers.push({ table: row.name, column: 'sqlite_master.sql', reason: 'native_schema_reference' });
  }
  if (!refs.length) return { changes, blockers, immutable };
  for (const { table, columns } of tablesAndColumns(db)) {
    for (const column of columns) {
      const identifier = quote(column), tableSql = quote(table);
      const statement = db.prepare(`SELECT ${identifier} AS value,COUNT(*) AS n FROM ${tableSql}
        WHERE typeof(${identifier}) IN ('text','blob') AND (${refs.map(() => `instr(CAST(${identifier} AS BLOB),CAST(? AS BLOB))>0`).join(' OR ')}) GROUP BY ${identifier}`);
      for (const row of statement.iterate(...refs)) {
        const field = `${table}.${column}`;
        if (typeof row.value !== 'string') {
          blockers.push({ table, column, reason: 'native_binary_reference' }); continue;
        }
        if (HISTORY_COLUMNS.has(field)) {
          immutable.push({ table, column, count: Number(row.n), valueHash: sha256(row.value), reason: 'native_historical_evidence' }); continue;
        }
        if (kind !== 'state' || !PATH_COLUMNS.has(field) || !path.isAbsolute(row.value)) {
          blockers.push({ table, column, reason: 'native_reference_unclassified' }); continue;
        }
        const after = replaceAccountPathSegments(row.value, mapping);
        if (after === row.value || containsMappedRef(after, mapping)) {
          blockers.push({ table, column, reason: 'native_rollout_path_unclassified' }); continue;
        }
        if (db.prepare(`SELECT 1 FROM ${tableSql} WHERE ${identifier}=? LIMIT 1`).get(after)
          || changes.some(change => change.table === table && change.column === column && change.after === after)) {
          blockers.push({ table, column, reason: 'native_reverse_path_collision' }); continue;
        }
        changes.push({ table, column, before: row.value, after, count: Number(row.n) });
      }
    }
  }
  return { changes, blockers, immutable };
}

module.exports = { nativeStoreKind, isNativeSidecar, nativeFingerprint, planNativeReferences };
