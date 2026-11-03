'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { buildLedger, migrationMap, ledgerIsApplicable } = require('./codex-identity-rekey');
const { readRekeyRecords } = require('./codex-rekey-storage');
const { MARKER_PREFIX, sha256, planDatabaseChanges, databaseFingerprint } = require('./rekey-database');
const { buildFilesystemPlan } = require('./codex-rekey-inventory');
const { atomicWrite } = require('./rekey-journal');

// Read-only planning and storage validation are independent of execution/recovery.
function openDatabase(root, readOnly) {
  const file = path.join(root, 'app-state.db');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('rekey_database_path_invalid');
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    let item;
    try { item = fs.lstatSync(candidate); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!item.isFile() || item.isSymbolicLink() || item.nlink > 1 || fs.realpathSync(candidate) !== candidate) {
      throw new Error('rekey_database_sidecar_invalid');
    }
  }
  const db = new DatabaseSync(file, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
    if (!readOnly) db.exec('PRAGMA synchronous=FULL');
    return db;
  } catch (error) {
    try { db.close(); } catch (_) { /* Preserve the original initialization error. */ }
    throw error;
  }
}

function digestPlan(plan) {
  const { digest, ...body } = plan;
  return sha256(JSON.stringify(body));
}

/** Purely read-only planning; neither account keys nor native files are changed. */
function createMaintenancePlan(aiHomeDir, providers = ['codex', 'grok']) {
  const root = fs.realpathSync(aiHomeDir);
  if (!Array.isArray(providers) || !providers.length || providers.some(provider => !['codex', 'grok'].includes(provider))) {
    throw new Error('rekey_provider_invalid');
  }
  providers = [...new Set(providers)].sort();
  const db = openDatabase(root, true);
  try {
    db.exec('BEGIN');
    const records = readRekeyRecords(db);
    const identities = providers.map(provider => ({
      ...buildLedger(records, 1, provider), external_blockers: [], database_blockers: []
    }));
    const mapping = new Map(identities.flatMap(ledger => [...migrationMap(ledger)]));
    const identityBlockers = identities.flatMap(ledger => ledgerIsApplicable(ledger).blockers.map(reason => ({ provider: ledger.provider, reason })));
    const database = planDatabaseChanges(db, mapping);
    const before = databaseFingerprint(db);
    const after = databaseFingerprint(db, database.changes);
    const filesystem = buildFilesystemPlan(fs, root, '', mapping);
    const plan = {
      version: 3, root, providers, identities, mapping: [...mapping],
      database: { ...database, before, after }, filesystem,
      blockers: [...identityBlockers, ...database.blockers, ...filesystem.blockers]
    };
    db.exec('COMMIT');
    return { ...plan, digest: digestPlan(plan) };
  } finally { db.close(); }
}

function validatePlan(plan, expectedDigest) {
  if (!plan || plan.version !== 3 || !/^[a-f0-9]{64}$/.test(expectedDigest || '')
    || digestPlan(plan) !== expectedDigest || plan.digest !== expectedDigest || !Array.isArray(plan.blockers)) {
    throw new Error('rekey_plan_modified_or_unconfirmed');
  }
  if (Buffer.byteLength(JSON.stringify(plan)) > 64 * 1024 * 1024) throw new Error('rekey_plan_size_limit');
  if (plan.blockers.length) throw new Error('rekey_plan_has_blockers');
}

function transactionMarker(db, id) {
  return db.prepare('SELECT value FROM app_kv WHERE key=?').get(MARKER_PREFIX + id)?.value || '';
}

function safeJournalDirectory(root, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('rekey_journal_id_invalid');
  return path.join(root, 'migration', `oauth-rekey-${id}`);
}

function readJournal(root, id) {
  const directory = safeJournalDirectory(root, id);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error('rekey_journal_path_invalid');
  const file = path.join(directory, 'journal.json');
  const fileStat = fs.lstatSync(file);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 128 * 1024 * 1024) throw new Error('rekey_journal_file_invalid');
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  validatePlan(journal.plan, journal.planDigest);
  if (journal.id !== id || journal.plan.root !== root) throw new Error('rekey_journal_identity_invalid');
  return { directory, journal };
}

function writeMaintenancePlan(file, plan) {
  const parent = path.dirname(file);
  const text = JSON.stringify(plan);
  if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error('rekey_plan_size_limit');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if ((fs.statSync(parent).mode & 0o077) !== 0) throw new Error('rekey_plan_parent_not_private');
  if (fs.existsSync(file)) throw new Error('rekey_plan_destination_exists');
  atomicWrite(fs, file, text, 0o600, crypto.randomUUID());
}

module.exports = { createMaintenancePlan, writeMaintenancePlan, digestPlan,
  validatePlan, openDatabase, transactionMarker, safeJournalDirectory, readJournal };
