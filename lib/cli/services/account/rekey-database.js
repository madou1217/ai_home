'use strict';

const crypto = require('node:crypto');
const { quote, tablesAndColumns } = require('./codex-rekey-storage');
const { classifyDatabaseText, referenceNeedles } = require('./codex-rekey-reference-policy');

const MARKER_PREFIX = 'maintenance:oauth-rekey:';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

/** Plans text-cell mutations only. Numeric/blob columns are never round-tripped. */
function planDatabaseChanges(db, mapping) {
  const changes = [];
  const blockers = [];
  const immutable = [];
  const refs = referenceNeedles(mapping);
  if (!refs.length) return { changes, blockers, immutable };
  // Schema SQL is future behavior, not historical provenance. Never silently
  // leave an old account in a trigger, view, partial index or CHECK constraint.
  for (const row of db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL").all()) {
    if (refs.some(ref => row.sql.includes(ref))) blockers.push({
      table: row.name, column: 'sqlite_master.sql', reason: 'rekey_schema_reference_requires_review'
    });
  }
  for (const { table, columns } of tablesAndColumns(db)) {
    for (const column of columns) {
      const identifier = quote(column);
      const query = db.prepare(`SELECT ${identifier} AS value, COUNT(*) AS n FROM ${quote(table)}
        WHERE typeof(${identifier})='text' AND (${refs.map(() => `instr(${identifier},?)>0`).join(' OR ')})
        GROUP BY ${identifier}`);
      for (const { value, n } of query.iterate(...refs)) {
        const result = classifyDatabaseText(table, column, value, mapping);
        if (result.kind === 'unknown') {
          blockers.push({ table, column, valueHash: sha256(value), reason: result.reason, details: result.details });
        } else if (result.kind === 'rewrite' && result.value !== value) {
          // Undo uses exact-value updates too. A pre-existing destination value
          // would coalesce unrelated rows, making reversal ambiguous even when
          // forward UPDATE has no UNIQUE constraint and appears to succeed.
          const exists = db.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${identifier}=? LIMIT 1`).get(result.value);
          const duplicate = changes.some(change => change.table === table && change.column === column && change.after === result.value);
          if (exists || duplicate) blockers.push({ table, column, reason: 'rekey_reverse_value_collision' });
          else changes.push({ table, column, before: value, after: result.value, count: Number(n) });
        } else if (result.kind === 'immutable') {
          immutable.push({ table, column, valueHash: sha256(value), count: Number(n), reason: result.reason });
        }
      }
    }
  }
  return { changes, blockers, immutable };
}

function cellBytes(value) {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `integer:${value}`;
  if (typeof value === 'number') return `real:${Object.is(value, -0) ? '-0' : value}`;
  if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString('hex')}`;
  return `text:${value}`;
}

/**
 * Order-independent row hashes include every stored byte and exact SQLite
 * integer. Predicting the post-state lets us catch unintended trigger effects,
 * dropped rows, usage changes and metadata loss, not merely count account rows.
 * The one transaction marker is excluded explicitly, never a whole table.
 */
function databaseFingerprint(db, changes = [], excludedMarker = '') {
  const replacements = new Map();
  for (const change of changes) {
    const key = `${change.table}\0${change.column}`;
    if (!replacements.has(key)) replacements.set(key, new Map());
    replacements.get(key).set(change.before, change.after);
  }
  const databaseHash = crypto.createHash('sha256');
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  databaseHash.update(JSON.stringify(schema));
  const counts = {};
  for (const { table, columns } of tablesAndColumns(db)) {
    const hashes = [];
    const statement = db.prepare(`SELECT * FROM ${quote(table)}`);
    statement.setReadBigInts(true);
    for (const row of statement.iterate()) {
      if (table === 'app_kv' && excludedMarker && row.key === excludedMarker) continue;
      const rowHash = crypto.createHash('sha256');
      for (const column of columns) {
        const map = replacements.get(`${table}\0${column}`);
        const value = map?.has(row[column]) ? map.get(row[column]) : row[column];
        const bytes = cellBytes(value);
        rowHash.update(`${column.length}:${column}:${Buffer.byteLength(bytes)}:`).update(bytes);
      }
      hashes.push(rowHash.digest('hex'));
    }
    hashes.sort();
    counts[table] = hashes.length;
    databaseHash.update(`${table}:${hashes.length}:`);
    for (const hash of hashes) databaseHash.update(hash);
  }
  return { digest: databaseHash.digest('hex'), counts };
}

function applyDatabaseChanges(db, changes, reverse = false) {
  let rows = 0;
  const ordered = reverse ? [...changes].reverse() : changes;
  for (const change of ordered) {
    const before = reverse ? change.after : change.before;
    const after = reverse ? change.before : change.after;
    const result = db.prepare(`UPDATE ${quote(change.table)} SET ${quote(change.column)}=? WHERE ${quote(change.column)}=?`).run(after, before);
    if (Number(result.changes) !== change.count) throw new Error('rekey_database_row_count_changed');
    rows += Number(result.changes);
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('rekey_foreign_key_violation');
  return rows;
}

module.exports = { MARKER_PREFIX, sha256, planDatabaseChanges, databaseFingerprint, applyDatabaseChanges };
