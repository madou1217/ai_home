'use strict';

// Explicit reviewed Codex identity migration. SQLite changes are transactional;
// runtime files/live references remain blockers, never silent partial success.
const { isDeepStrictEqual } = require('node:util');
const { buildCodexOAuthIdentitySeed } = require('../../../account/codex-auth-metadata');
const { buildGrokIdentitySeed, buildLegacyGrokIdentitySeed } = require('../../../account/grok-identity');
const { extractOAuthEmail } = require('../../../account/transfer-core');
const { getPublicAccountRef } = require('../../../account/public-account-ref');
const { quote, readRekeyRecords, recordsFingerprint, openRekeyDatabase, tablesAndColumns,
  planDatabaseReferenceChanges, findExternalRekeyReferences } = require('./codex-rekey-storage');
const RESOLUTION = Object.freeze({ ALREADY_CURRENT: 'already_current', MIGRATE: 'migrate',
  CONFLICT: 'conflict', UNVERIFIABLE: 'unverifiable', UNRECOGNIZED: 'unrecognized', NOT_APPLICABLE: 'not_applicable' });
const ACCOUNT_REF_COLUMNS = Object.freeze(['account_ref', 'execution_account_ref']);
const LEDGER_SCHEMA_VERSION = 2;
const object = raw => { try { const value = JSON.parse(raw || '{}'); return value && typeof value === 'object' ? value : {}; } catch (_) { return {}; } };

const SCHEMES = Object.freeze({
  codex: { from: 'oauth:codex:<email>', to: 'oauth:codex:<user_id>', apiKey: 'OPENAI_API_KEY',
    current: buildCodexOAuthIdentitySeed, legacy: (_auth, email) => email ? `oauth:codex:${email}` : '' },
  grok: { from: 'oauth:grok:<email-or-profile-email-set>', to: 'oauth:grok:auth:<stable-id-set-digest>', apiKey: 'XAI_API_KEY',
    current: buildGrokIdentitySeed, legacy: buildLegacyGrokIdentitySeed }
});
function buildLedger(records, now = Date.now(), provider = 'codex') {
  const scheme = SCHEMES[provider];
  if (!scheme) throw new Error('unsupported_identity_rekey_provider');
  const claimed = new Map(records.map(record => [record.account_ref, record.account_ref]));
  const entries = [];
  for (const record of records.filter(item => item.provider === provider)) {
    const nativeAuth = object(record.native_auth_json), auth = nativeAuth.auth || nativeAuth;
    const env = object(record.env_json);
    const email = String(extractOAuthEmail(provider, nativeAuth) || '').trim().toLowerCase();
    const identitySeed = scheme.current(auth);
    const newRef = identitySeed ? getPublicAccountRef(`unique:${identitySeed}`) : '';
    const oldSeed = scheme.legacy(auth, email);
    const oldRef = oldSeed ? getPublicAccountRef(`unique:${oldSeed}`) : '';
    const entry = { old_account_ref: record.account_ref, new_account_ref: '', resolution: '',
      cli_account_id: record.cli_account_id || '', identity_seed: identitySeed, email, note: '' };
    if (env[scheme.apiKey] || auth[scheme.apiKey]) {
      entry.resolution = RESOLUTION.NOT_APPLICABLE; entry.identity_seed = ''; entry.note = 'API-key 账号不属于 OAuth rekey';
    } else if (newRef && newRef === record.account_ref) {
      entry.resolution = RESOLUTION.ALREADY_CURRENT; entry.new_account_ref = newRef;
    } else if (!oldRef || oldRef !== record.account_ref) {
      entry.resolution = RESOLUTION.UNRECOGNIZED; entry.note = `accountRef 不属于已知的 ${provider} OAuth 向量`;
    } else if (!newRef) {
      entry.resolution = RESOLUTION.UNVERIFIABLE; entry.note = '缺少稳定 user_id';
    } else {
      entry.new_account_ref = newRef;
      if (claimed.has(newRef) && claimed.get(newRef) !== record.account_ref) {
        entry.resolution = RESOLUTION.CONFLICT; entry.note = '目标身份已被占用，需要人工裁决';
      } else { entry.resolution = RESOLUTION.MIGRATE; claimed.set(newRef, record.account_ref); }
    }
    entries.push(entry);
  }
  const summary = { total: entries.length, ...Object.fromEntries(Object.values(RESOLUTION).map(key => [key, 0])) };
  for (const entry of entries) summary[entry.resolution]++;
  return { schema_version: LEDGER_SCHEMA_VERSION, identity_scheme_version: 1, provider,
    from_vector: scheme.from, to_vector: scheme.to,
    source_fingerprint: recordsFingerprint(records), generated_at: new Date(now).toISOString(), summary, entries };
}
function migrationMap(ledger) {
  return new Map(ledger.entries.filter(entry => entry.resolution === RESOLUTION.MIGRATE)
    .map(entry => [entry.old_account_ref, entry.new_account_ref]));
}
function planCodexIdentityRekey(deps) {
  const { fs, aiHomeDir } = deps;
  const db = openRekeyDatabase(fs, aiHomeDir, true);
  try {
    if (db) db.exec('BEGIN');
    const ledger = buildLedger(readRekeyRecords(db), deps.now || Date.now(), deps.provider || 'codex');
    const mapping = migrationMap(ledger);
    ledger.external_blockers = findExternalRekeyReferences(fs, aiHomeDir, [...mapping.keys()]);
    ledger.database_blockers = db ? planDatabaseReferenceChanges(db, mapping).blockers : [];
    if (db) db.exec('COMMIT');
    return { ledger, summary: ledger.summary };
  } finally { db?.close(); }
}

function ledgerIsApplicable(ledger) {
  const blockers = [];
  const scheme = SCHEMES[ledger && ledger.provider];
  if (!ledger || ledger.schema_version !== LEDGER_SCHEMA_VERSION || !scheme
    || ledger.identity_scheme_version !== 1 || ledger.from_vector !== scheme.from
    || ledger.to_vector !== scheme.to || !Array.isArray(ledger.entries)
    || !/^[a-f0-9]{64}$/.test(ledger.source_fingerprint || '') || !Array.isArray(ledger.external_blockers)
    || !Array.isArray(ledger.database_blockers)) return { applicable: false, blockers: ['账本结构/版本无效，请重新生成'] };
  const counts = { total: ledger.entries.length, ...Object.fromEntries(Object.values(RESOLUTION).map(key => [key, 0])) };
  const sources = new Set(), targets = new Set();
  for (const entry of ledger.entries) {
    if (!entry || !Object.values(RESOLUTION).includes(entry.resolution)
      || !/^acct_[a-f0-9]{20}$/.test(entry.old_account_ref || '') || sources.has(entry.old_account_ref)) {
      blockers.push('账本条目无效/重复'); continue;
    }
    sources.add(entry.old_account_ref); counts[entry.resolution]++;
    if (entry.resolution === RESOLUTION.MIGRATE) {
      if (!String(entry.identity_seed || '').startsWith(`oauth:${ledger.provider}:`)
        || entry.new_account_ref !== getPublicAccountRef(`unique:${entry.identity_seed}`)
        || entry.old_account_ref === entry.new_account_ref || targets.has(entry.new_account_ref)) blockers.push('迁移目标无效/重复');
      targets.add(entry.new_account_ref);
    }
  }
  if (!isDeepStrictEqual(counts, ledger.summary)) blockers.push('账本统计与条目不一致');
  if (counts.conflict) blockers.push(`${counts.conflict} 个冲突未裁决`);
  if (counts.unverifiable) blockers.push(`${counts.unverifiable} 个账号缺稳定 user_id`);
  if (counts.unrecognized) blockers.push(`${counts.unrecognized} 个账号不属于已知向量`);
  if (ledger.external_blockers.length) blockers.push('磁盘运行目录/配置仍引用旧账号，不能仅迁移 SQLite');
  if (ledger.database_blockers.length) blockers.push('数据库存在嵌入式引用，需要人工裁决');
  return { applicable: blockers.length === 0, blockers };
}
function listAccountRefColumns(db) {
  return tablesAndColumns(db).flatMap(({ table, columns }) => columns.filter(column => ACCOUNT_REF_COLUMNS.includes(column)).map(column => ({ table, column })));
}
function applyCodexIdentityRekey(deps) {
  const { fs, aiHomeDir, ledger } = deps;
  const applicability = ledgerIsApplicable(ledger);
  if (!applicability.applicable) return { applied: false, reason: 'ledger_has_blockers', blockers: applicability.blockers, rewritten: 0 };
  const db = openRekeyDatabase(fs, aiHomeDir, false);
  if (!db) return { applied: false, reason: 'app_state_db_missing', rewritten: 0 };
  let inTransaction = false;
  try {
    db.exec('PRAGMA foreign_keys=ON'); db.exec('BEGIN IMMEDIATE'); inTransaction = true;
    db.exec('PRAGMA defer_foreign_keys=ON');
    const current = buildLedger(readRekeyRecords(db), Date.now(), ledger.provider);
    if (current.source_fingerprint !== ledger.source_fingerprint || !isDeepStrictEqual(current.entries, ledger.entries)
      || !isDeepStrictEqual(current.summary, ledger.summary)) throw new Error('ledger_stale_or_modified');
    const mapping = migrationMap(current);
    if (findExternalRekeyReferences(fs, aiHomeDir, [...mapping.keys()]).length) throw new Error('external_references_changed');
    const { changes, blockers } = planDatabaseReferenceChanges(db, mapping);
    if (blockers.length) throw new Error('embedded_reference_requires_review');
    let rewritten = 0;
    for (const change of changes) {
      const result = db.prepare(`UPDATE ${quote(change.table)} SET ${quote(change.column)}=? WHERE ${quote(change.column)}=?`).run(change.after, change.before);
      rewritten += Number(result.changes) || 0;
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('foreign_key_violation');
    const remaining = planDatabaseReferenceChanges(db, mapping);
    if (remaining.changes.length || remaining.blockers.length) throw new Error('unresolved_database_references');
    db.exec('COMMIT'); inTransaction = false;
    return { applied: true, reason: mapping.size ? 'applied' : 'nothing_to_do', rewritten,
      targets: changes.map(({ table, column }) => ({ table, column })) };
  } catch (error) {
    if (inTransaction) { try { db.exec('ROLLBACK'); } catch (_) {} }
    return { applied: false, reason: 'apply_failed', error: String(error.message || error), rewritten: 0 };
  } finally { db.close(); }
}
module.exports = { ACCOUNT_REF_COLUMNS, LEDGER_SCHEMA_VERSION, RESOLUTION, applyCodexIdentityRekey,
  ledgerIsApplicable, listAccountRefColumns, planCodexIdentityRekey,
  planOAuthIdentityRekey: planCodexIdentityRekey, applyOAuthIdentityRekey: applyCodexIdentityRekey };
