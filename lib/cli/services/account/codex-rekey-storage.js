'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { getAppStateDbPath } = require('../../../server/app-state-store');
const quote = name => `"${String(name).replace(/"/g, '""')}"`;
function readRekeyRecords(db) {
  if (!db) return [];
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  if (!tables.has('account_refs')) return [];
  const aliases = tables.has('account_cli_aliases'), credentials = tables.has('account_credentials');
  return db.prepare(`SELECT r.account_ref, r.provider, r.created_at, r.updated_at,
    ${aliases ? 'a.cli_account_id' : "''"} AS cli_account_id,
    ${credentials ? 'c.env_json, c.native_auth_json, c.native_auth_updated_at, c.env_updated_at' : "'{}' AS env_json, '{}' AS native_auth_json, 0 AS native_auth_updated_at, 0 AS env_updated_at"}
    FROM account_refs r ${aliases ? 'LEFT JOIN account_cli_aliases a ON a.account_ref=r.account_ref' : ''}
    ${credentials ? 'LEFT JOIN account_credentials c ON c.account_ref=r.account_ref' : ''}
    ORDER BY r.account_ref`).all();
}
function recordsFingerprint(records) {
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}
function openRekeyDatabase(fs, aiHomeDir, readOnly) {
  const file = getAppStateDbPath(aiHomeDir);
  if (!file || !fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly });
  db.exec('PRAGMA busy_timeout=5000');
  if (readOnly) db.exec('PRAGMA query_only=ON');
  return db;
}
function tablesAndColumns(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => ({ table: row.name, columns: db.prepare('SELECT name FROM pragma_table_info(?)').all(row.name).map(item => item.name) }));
}
function replaceJsonRefs(value, mapping, budget = { left: 100000 }) {
  if (--budget.left < 0) throw new Error('reference_document_too_large');
  if (typeof value === 'string') return mapping.get(value) || value;
  if (Array.isArray(value)) return value.map(item => replaceJsonRefs(item, mapping, budget));
  if (value && typeof value === 'object') {
    const next = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      const renamed = mapping.get(key) || key;
      if (Object.hasOwn(next, renamed)) throw new Error('json_reference_key_collision');
      next[renamed] = replaceJsonRefs(item, mapping, budget);
    }
    return next;
  }
  return value;
}
// Only exact scalar IDs, JSON IDs and namespaced app_kv keys are transformable.
// Free text/paths embedding an accountRef require explicit review.
function planDatabaseReferenceChanges(db, mapping) {
  const changes = [], blockers = [], refs = [...mapping.keys()];
  if (!refs.length) return { changes, blockers };
  for (const { table, columns } of tablesAndColumns(db)) for (const column of columns) {
    const identifier = quote(column);
    const rows = db.prepare(`SELECT DISTINCT ${identifier} AS value FROM ${quote(table)}
      WHERE typeof(${identifier})='text' AND (${refs.map(() => `instr(${identifier}, ?) > 0`).join(' OR ')})`).all(...refs);
    for (const { value } of rows) {
      let next = mapping.get(value);
      if (!next && table === 'app_kv' && column === 'key') next = value.split(':').map(part => mapping.get(part) || part).join(':');
      if (!next) {
        try { next = JSON.stringify(replaceJsonRefs(JSON.parse(value), mapping)); }
        catch (_) { next = value; }
      }
      if (refs.some(ref => next.includes(ref))) { blockers.push({ table, column, reason: 'embedded_reference_requires_review' }); continue; }
      if (next !== value) changes.push({ table, column, before: value, after: next });
    }
  }
  return { changes, blockers };
}

// Runtime files cannot participate in the SQLite transaction. Refuse to claim
// an account migration while those old IDs still address restartable writers.
function findExternalRekeyReferences(fs, aiHomeDir, refs) {
  if (!refs.length) return [];
  const blockers = [], pending = ['run', 'runtime', 'profiles', 'config'].map(root => path.join(aiHomeDir, root));
  // Hook/desktop state lives at the data root, outside run/. These are live
  // references too. Do not scan export/backup/migration ledgers as live config.
  try {
    for (const name of fs.readdirSync(aiHomeDir)) {
      if (/\.(json|toml|ya?ml|conf|plist)$/.test(name)) pending.push(path.join(aiHomeDir, name));
    }
  } catch (error) { if (error.code !== 'ENOENT') blockers.push({ reason: 'external_root_unreadable' }); }
  let inspected = 0;
  while (pending.length) {
    const file = pending.pop();
    if (++inspected > 20000) { blockers.push({ reason: 'external_scan_limit' }); break; }
    let stat; try { stat = fs.lstatSync(file); } catch (error) {
      if (error.code !== 'ENOENT') blockers.push({ reason: 'external_path_unreadable' }); continue;
    }
    if (refs.some(ref => file.includes(ref))) {
      blockers.push({ path: path.relative(aiHomeDir, file), reason: 'external_account_reference' }); continue;
    }
    if (stat.isSymbolicLink()) {
      let target; try { target = fs.readlinkSync(file); } catch (_) { blockers.push({ reason: 'external_link_unreadable' }); continue; }
      if (refs.some(ref => target.includes(ref))) blockers.push({ path: path.relative(aiHomeDir, file), reason: 'external_account_reference' });
      continue;
    }
    if (stat.isDirectory()) {
      try { for (const name of fs.readdirSync(file)) pending.push(path.join(file, name)); }
      catch (_) { blockers.push({ path: path.relative(aiHomeDir, file), reason: 'external_path_unreadable' }); }
    } else if (stat.isFile() && /\.(json|toml|ya?ml|conf|plist|cmd|sh)$/.test(file)) {
      if (stat.size > 4 * 1024 * 1024) { blockers.push({ path: path.relative(aiHomeDir, file), reason: 'external_file_too_large' }); continue; }
      try {
        const content = fs.readFileSync(file, 'utf8');
        if (refs.some(ref => content.includes(ref))) blockers.push({ path: path.relative(aiHomeDir, file), reason: 'external_account_reference' });
      } catch (_) { blockers.push({ path: path.relative(aiHomeDir, file), reason: 'external_file_unreadable' }); }
    }
  }
  return blockers;
}
module.exports = { quote, readRekeyRecords, recordsFingerprint, openRekeyDatabase,
  tablesAndColumns, planDatabaseReferenceChanges, findExternalRekeyReferences };
