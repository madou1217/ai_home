'use strict';

const { TextDecoder } = require('node:util');
const { layout, canonical, objectPath, createObject, verifyObject, digest } = require('./repository-object');
const { readVerifiedManifest, verifyBackupObject, integrityError } = require('./remote-backup-integrity');
const { manifestAccountPath } = require('./remote-backup-manifest');
const formatBytes = Buffer.from(`${canonical(layout)}\n`);

function parseManifest(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (_error) { throw integrityError('backup_manifest_invalid'); }
  if (value?.kind !== 'aih-account-backup' || value.version !== 2 || value.objectEncoding !== layout.objectEncoding) throw integrityError('backup_manifest_unsupported');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !value.accounts || typeof value.accounts !== 'object' || Array.isArray(value.accounts)) throw integrityError('backup_manifest_invalid');
  if (Object.keys(value.accounts).length > layout.maxAccounts) throw integrityError('backup_too_many_accounts');
  for (const [ref, entry] of Object.entries(value.accounts)) {
    if (!/^acct_[a-f0-9]{20}$/.test(ref) || !entry || typeof entry.provider !== 'string' || !/^[a-z0-9._-]{1,64}$/.test(entry.provider) || entry.provider === '.' || entry.provider === '..') throw integrityError('backup_manifest_invalid');
    if (entry.deleted !== undefined && typeof entry.deleted !== 'boolean') throw integrityError('backup_manifest_invalid', ref);
    if (entry.legacy !== undefined) {
      if (entry.deleted !== true || Object.hasOwn(entry, 'objectSha256') || Object.hasOwn(entry, 'bytes') || entry.legacy?.provider !== entry.provider || entry.legacy?.deleted !== true) throw integrityError('backup_manifest_invalid', ref);
      if (entry.legacy.bytes > layout.maxObjectBytes) throw integrityError('backup_manifest_invalid', ref);
      readVerifiedManifest(JSON.stringify({ kind: 'aih-account-backup', version: 1, revision: 0, accounts: { [ref]: entry.legacy } }));
      continue;
    }
    objectPath(entry.objectSha256);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > layout.maxObjectBytes) throw integrityError('backup_manifest_invalid', ref);
  }
  if (Object.values(value.accounts).reduce((sum, entry) => sum + (entry.deleted ? 0 : entry.bytes), 0) > layout.maxSnapshotBytes) throw integrityError('backup_snapshot_too_large');
  if (value.skipped !== undefined && (!Array.isArray(value.skipped) || value.skipped.some((ref) => !/^acct_[a-f0-9]{20}$/.test(ref)))) throw integrityError('backup_manifest_invalid');
  if (!Buffer.from(`${canonical(value)}\n`).equals(Buffer.from(bytes))) throw integrityError('backup_manifest_encoding_mismatch');
  return value;
}

async function readState(scope) {
  const marker = await scope.read(layout.formatPath, layout.maxManifestBytes);
  const raw = await scope.read(layout.manifestPath, layout.maxManifestBytes);
  if (!marker && raw) throw integrityError('backup_repository_format_missing');
  if (marker && !marker.equals(formatBytes)) throw integrityError('backup_repository_format_unsupported');
  if (raw) return { manifest: parseManifest(raw), raw, initialized: true };
  if (marker) throw integrityError('backup_repository_initialization_required');
  const legacyRaw = await scope.read('manifest.json', layout.maxManifestBytes);
  const legacy = readVerifiedManifest(legacyRaw);
  return { manifest: null, raw: null, initialized: Boolean(marker), legacy, legacyRaw };
}

async function migrateLegacy(scope, legacy) {
  const accounts = {};
  for (const [ref, entry] of Object.entries(legacy?.accounts || {})) {
    const bytes = await scope.read(manifestAccountPath(ref, entry), layout.maxObjectBytes);
    if (!bytes && entry.deleted) { accounts[ref] = { provider: entry.provider, deleted: true, legacy: entry }; continue; }
    const record = verifyBackupObject(bytes, ref, entry);
    const object = createObject(record);
    await scope.putImmutable(object.path, object.content);
    accounts[ref] = { ...object.entry, ...(entry.deleted ? { deleted: true } : {}) };
  }
  return { kind: 'aih-account-backup', version: 2, objectEncoding: layout.objectEncoding, revision: legacy?.revision || 0, source: legacy?.source || { host: '' }, accounts };
}

async function syncRepository(strategy, { accounts, skipped = [], hostName, full = false }) {
  if (typeof strategy.beginRepository !== 'function') throw integrityError('backup_repository_transport_unsupported');
  // Validate local objects before acquiring the lock or creating a format marker.
  const objects = new Map();
  for (const record of accounts || []) {
    if (objects.has(record.accountRef)) throw integrityError('backup_duplicate_account_ref');
    objects.set(record.accountRef, createObject(record));
  }
  if (objects.size > layout.maxAccounts) throw integrityError('backup_too_many_accounts');
  const skipRefs = [...new Set(skipped.map((item) => item.accountRef))].sort();
  if (skipRefs.some((ref) => !/^acct_[a-f0-9]{20}$/.test(ref))) throw integrityError('backup_export_incomplete');
  if (skipRefs.some((ref) => objects.has(ref))) throw integrityError('backup_export_ambiguous');
  const scope = await strategy.beginRepository(); let failure;
  try {
    const state = await readState(scope);
    // A pre-existing marker with no manifest is never treated as an empty
    // repository. Recovery must be explicit; ordinary sync cannot reset it.
    const previous = state.manifest || await migrateLegacy(scope, state.legacy);
    const next = {}, activeRefs = new Set(objects.keys()); let uploaded = 0, unchanged = 0, deleted = 0;
    for (const [ref, object] of objects) {
      const created = await scope.putImmutable(object.path, object.content, full);
      if (created) uploaded += 1; else unchanged += 1;
      next[ref] = object.entry;
    }
    for (const ref of skipRefs) {
      if (activeRefs.has(ref)) throw integrityError('backup_export_ambiguous');
      if (previous.accounts[ref]) next[ref] = previous.accounts[ref];
    }
    for (const [ref, prior] of Object.entries(previous.accounts)) {
      if (next[ref]) continue;
      next[ref] = { ...prior, deleted: true }; if (!prior.deleted) deleted += 1;
    }
    if (Object.keys(next).length > layout.maxAccounts) throw integrityError('backup_too_many_accounts');
    if (Object.values(next).reduce((sum, entry) => sum + (entry.deleted ? 0 : entry.bytes), 0) > layout.maxSnapshotBytes) throw integrityError('backup_snapshot_too_large');
    // Validate all referenced active objects, including skipped/prior entries.
    for (const [ref, entry] of Object.entries(next)) if (!entry.deleted) {
      const bytes = await scope.read(objectPath(entry.objectSha256), layout.maxObjectBytes);
      verifyObject(bytes, ref, entry);
    }
    if (Object.values(next).reduce((sum, entry) => sum + (entry.deleted ? 0 : entry.bytes), 0) > layout.maxSnapshotBytes) throw integrityError('backup_snapshot_too_large');
    const changed = !state.manifest || full || canonical(previous.accounts) !== canonical(next) || canonical(previous.skipped || []) !== canonical(skipRefs);
    const manifest = { kind: 'aih-account-backup', version: 2, objectEncoding: layout.objectEncoding,
      source: { host: hostName || previous.source?.host || '' }, revision: previous.revision + (changed ? 1 : 0),
      accounts: next, ...(skipRefs.length ? { skipped: skipRefs } : {}) };
    const bytes = Buffer.from(`${canonical(manifest)}\n`);
    parseManifest(bytes);
    if (bytes.length > layout.maxManifestBytes) throw integrityError('backup_manifest_too_large');
    if (changed) {
      const hash = digest(bytes);
      await scope.putImmutable(`${layout.manifestsPrefix}${hash}.json`, bytes);
      await scope.journal(Buffer.from(`${canonical({ kind: 'aih-backup-publish-intent', version: 2, manifestSha256: hash, previousSha256: state.raw ? digest(state.raw) : '' })}\n`));
      try {
        if (!state.initialized) await scope.putImmutable(layout.formatPath, formatBytes);
        await scope.publish(layout.manifestPath, bytes);
      } catch (error) { scope.retain(); throw error; }
    }
    return { manifest, uploaded, unchanged, deleted, changed, incomplete: skipRefs, manifestSha256: digest(bytes) };
  } catch (error) { failure = error; throw error; }
  finally {
    try { await scope.release(); }
    catch (error) { if (failure) error.cause = failure; throw error; }
  }
}

async function readSnapshot(strategy) {
  if (typeof strategy.beginRepository !== 'function') throw integrityError('backup_repository_transport_unsupported');
  const scope = await strategy.beginRepository(); let state;
  try { state = await readState(scope); }
  finally { await scope.release(); }
  return state.manifest ? { manifest: state.manifest, version: 2 } : { manifest: state.legacy, version: 1 };
}

async function readSnapshotObjects(strategy) {
  if (typeof strategy.beginRepository !== 'function') throw integrityError('backup_repository_transport_unsupported');
  const scope = await strategy.beginRepository();
  try {
    const state = await readState(scope);
    const manifest = state.manifest || state.legacy;
    const version = state.manifest ? 2 : 1;
    const accounts = [], missing = [], corrupt = [];
    let total = 0;
    for (const [ref, entry] of Object.entries(manifest?.accounts || {}).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (entry.deleted) continue;
      total += entry.bytes;
      if (total > layout.maxSnapshotBytes) throw integrityError('backup_snapshot_too_large');
      const path = version === 2 ? objectPath(entry.objectSha256) : manifestAccountPath(ref, entry);
      const bytes = await scope.read(path, layout.maxObjectBytes);
      try { accounts.push(version === 2 ? verifyObject(bytes, ref, entry) : verifyBackupObject(bytes, ref, entry)); }
      catch (error) {
        if (error.code === 'backup_object_missing') missing.push(ref);
        else corrupt.push({ accountRef: ref, error: error.code || 'backup_object_invalid' });
      }
    }
    return { manifest, version, accounts, missing, corrupt };
  } finally { await scope.release(); }
}

module.exports = { formatBytes, parseManifest, readState, syncRepository, readSnapshot, readSnapshotObjects };
