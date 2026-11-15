'use strict';

const { TextDecoder } = require('node:util');
const { layout, canonical, digest, objectPath, verifyObject } = require('./repository-object');
const { formatBytes, parseManifest } = require('./repository-manifest');
const { integrityError } = require('./remote-backup-integrity');
function parseIntent(bytes) {
  if (!bytes) return null;
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch (_) { throw integrityError('backup_recovery_intent_invalid'); }
  if (value?.kind !== 'aih-backup-publish-intent' || value.version !== 2 || typeof value.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifestSha256)
    || typeof value.previousSha256 !== 'string' || (value.previousSha256 !== '' && !/^[a-f0-9]{64}$/.test(value.previousSha256))) throw integrityError('backup_recovery_intent_invalid');
  return value;
}
async function verifyReferences(scope, manifest) {
  for (const [ref, entry] of Object.entries(manifest.accounts)) {
    if (entry.deleted && !entry.objectSha256) continue;
    verifyObject(await scope.read(objectPath(entry.objectSha256), layout.maxObjectBytes), ref, entry);
  }
}
async function recoverRepository(strategy, options = {}) {
  const access = await strategy.repositoryRecovery();
  const observed = await access.inspect();
  const owner = observed.owner || observed.receipt?.sourceOwner || '';
  const intent = parseIntent(observed.intent);
  if (!owner) throw integrityError('backup_recovery_lock_missing_or_invalid');
  if (options.dryRun || !options.confirmStopped) return { ok: true, dryRun: true, owner, recoveryToken: observed.receipt?.token, attemptToken: observed.attempt || undefined, intent,
    action: 'confirm_all_original_and_recovery_writers_stopped_before_recovery' };
  if (options.owner !== owner) throw integrityError('backup_lock_ownership_changed');
  const claim = await access.claim(owner, options.recoveryToken, options.attemptToken);
  // Gate remains until all validation, publish and scope release have completed.
  // Failed acquisition never reopens the gap for ordinary writers.
  let scope;
  try { scope = await strategy.beginRepository({ recovery: true }); }
  catch (error) {
    error.recoveryPath = claim.path; error.recoveryToken = claim.receipt.token; error.attemptToken = claim.attempt;
    throw error;
  }
  let retain = true, failure;
  try {
    const frozenIntent = parseIntent(claim.intent);
    if (frozenIntent) await scope.journal(Buffer.from(`${canonical(frozenIntent)}\n`));
    const current = await scope.read(layout.manifestPath, layout.maxManifestBytes);
    const marker = await scope.read(layout.formatPath, layout.maxManifestBytes);
    if (current && !marker) throw integrityError('backup_repository_format_missing');
    if (marker && !marker.equals(formatBytes)) throw integrityError('backup_repository_format_unsupported');
    const auxiliary = await claim.replacementEvidence();
    if (!frozenIntent) {
      if (auxiliary || (marker && !current)) throw integrityError('backup_recovery_intent_missing');
      if (current) await verifyReferences(scope, parseManifest(current));
      retain = false;
      return { ok: true, quarantine: claim.path, action: current ? 'preserved_current_snapshot' : 'no_published_snapshot', revision: current ? parseManifest(current).revision : 0 };
    }
    const snapshot = await scope.read(`${layout.manifestsPrefix}${frozenIntent.manifestSha256}.json`, layout.maxManifestBytes);
    if (!snapshot || digest(snapshot) !== frozenIntent.manifestSha256) throw integrityError('backup_recovery_snapshot_missing_or_changed');
    const manifest = parseManifest(snapshot); await verifyReferences(scope, manifest);
    const hash = current ? digest(current) : '';
    if (hash && hash !== frozenIntent.manifestSha256 && hash !== frozenIntent.previousSha256) throw integrityError('backup_recovery_snapshot_diverged');
    if (!hash && frozenIntent.previousSha256 && !auxiliary?.previous.includes(frozenIntent.previousSha256)) throw integrityError('backup_recovery_missing_previous_evidence');
    if (auxiliary) {
      if (auxiliary.previous.some((value) => value !== frozenIntent.previousSha256 && value !== frozenIntent.manifestSha256)) throw integrityError('backup_recovery_auxiliary_mismatch');
      await auxiliary.quarantine(); // preserve rather than delete its previous object
    }
    if (hash !== frozenIntent.manifestSha256) {
      if (!marker) await scope.putImmutable(layout.formatPath, formatBytes);
      await scope.publish(layout.manifestPath, snapshot);
    }
    retain = false;
    return { ok: true, quarantine: claim.path, action: hash === frozenIntent.manifestSha256 ? 'confirmed_published_snapshot' : 'published_verified_snapshot', revision: manifest.revision };
  } catch (error) {
    failure = error; error.recoveryPath = claim.path; error.recoveryToken = claim.receipt.token; error.attemptToken = claim.attempt;
    if (retain) scope.retain(); throw error;
  } finally {
    if (failure) {
      try { await scope.release(); } catch (cleanup) { failure.cleanupCode = cleanup.code; failure.retainedLock = cleanup.recoveryPath; }
    } else {
      await scope.release();
      await claim.finish();
    }
  }
}
module.exports = { recoverRepository };
