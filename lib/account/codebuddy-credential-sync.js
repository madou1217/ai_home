'use strict';

const path = require('node:path');
const { inspectCodebuddyCredential, compareCodebuddyCredentials,
  readCodebuddyCredentialFile, codebuddyCredentialPaths, PRIMARY } = require('./codebuddy-credential-source');
const store = require('../server/account-credential-store');
const { registerAccountIdentity } = require('./account-registration');
const { resolveNativeAuthIdentitySeed } = require('./account-identity');
const { insertAccountNativeAuthIfMissing } = require('../server/account-credential-store-insert');
const { resolveCliAccountRef, resolveAccountRef, getPublicAccountRef } = require('../server/account-ref-store');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');

function adoptCodebuddyCredential(fs, aiHomeDir, provider, credential, options = {}) {
  const checked = inspectCodebuddyCredential(credential, provider, options.nowMs);
  if (!checked.ok) return { updated: false, reason: checked.reason };
  if (checked.expiresAt && checked.expiresAt <= (options.nowMs || Date.now())) return { updated: false, reason: 'candidate_credential_expired' };
  const identity = resolveNativeAuthIdentitySeed(provider, { credentials: credential });
  if (!identity.identitySeed || identity.degraded) return { updated: false, reason: 'identity_unverifiable' };
  let registration;
  if (options.accountRef) {
    const target = resolveAccountRef(fs, aiHomeDir, options.accountRef, { bestEffort: true });
    if (!target || target.provider !== provider) return { updated: false, reason: 'account_provider_mismatch' };
    registration = { accountRef: target.accountRef, created: false };
  } else {
    // An earlier identity scheme may have produced a different accountRef.
    // Match the actual grant scope before allocating; do not silently rekey or
    // create a duplicate when the same native login is observed again.
    const matches = store.listAccountCredentialRecords(fs, aiHomeDir, provider)
      .filter(record => inspectCodebuddyCredential(record.nativeAuth?.credentials, provider).scope === checked.scope);
    if (matches.length > 1) return { updated: false, reason: 'ambiguous_existing_identity' };
    registration = matches.length ? { accountRef: matches[0].accountRef, created: false }
      : registerAccountIdentity(fs, aiHomeDir, { provider, identitySeed: identity.identitySeed,
        cliAccountId: options.cliAccountId || '', respectDeletion: options.automatic === true });
  }
  const accountRef = registration.accountRef;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = store.readAccountCredentialRecord(fs, aiHomeDir, accountRef);
    if (!current && accountRef !== getPublicAccountRef(`unique:${identity.identitySeed}`)) return { updated: false, reason: 'account_identity_unverifiable' };
    if (current && (current.provider !== provider || current.env?.CODEBUDDY_API_KEY)) return { updated: false, reason: 'account_mode_conflict' };
    const decision = compareCodebuddyCredentials(current?.nativeAuth?.credentials, credential, provider, options.nowMs);
    const alias = resolveCliAccountRef(fs, aiHomeDir, accountRef, { bestEffort: true });
    if (!decision.adopt) return { updated: false, registered: decision.reason === 'unchanged' || decision.reason === 'older_credential',
      accountRef, cliAccountId: alias?.cliAccountId || '', reason: decision.reason };
    const next = { ...(current?.nativeAuth || {}), credentials: credential,
      codebuddyNativeObservation: { fingerprint: checked.fingerprint, observedAt: Date.now() } };
    if (options.hostId) next.codebuddyCredentialHostId = options.hostId;
    const saved = current ? store.compareAndSwapAccountNativeAuth(fs, aiHomeDir, accountRef, current, next)
      : insertAccountNativeAuthIfMissing(fs, aiHomeDir, accountRef, next);
    if (saved) return { updated: true, registered: true, accountRef,
      cliAccountId: alias?.cliAccountId || registration.cliAccountId || '', created: registration.created === true, reason: decision.reason };
  }
  return { updated: false, reason: 'concurrent_credential_update' };
}

function createCodebuddyNativeCredentialSync(options = {}) {
  const { fs, aiHomeDir, hostHomeDir } = options;
  let timer, stopped = false, last = { scanned: 0, updated: [], skipped: [] };
  const pending = new Map();
  function scan() {
    const result = { scanned: 0, updated: [], skipped: [] };
    if (!fs || !aiHomeDir || !hostHomeDir) return result;
    const records = Object.keys(PRIMARY).flatMap(provider => store.listAccountCredentialRecords(fs, aiHomeDir, provider));
    const sources = new Map();
    for (const provider of Object.keys(PRIMARY)) {
      // The source issuer, not a filename suffix, assigns the standalone CLI.
      for (const file of codebuddyCredentialPaths(hostHomeDir, provider)) sources.set(file, { file, host: true });
      for (const record of records.filter(item => item.provider === provider)) {
        for (const file of codebuddyCredentialPaths(resolveAccountRuntimeDir(aiHomeDir, provider, record.accountRef), provider)) {
          sources.set(file, { file, provider, accountRef: record.accountRef });
        }
      }
    }
    for (const source of sources.values()) {
      const snapshot = readCodebuddyCredentialFile(fs, source.file, source.provider || ''); result.scanned += 1;
      if (!snapshot.ok) {
        if (snapshot.reason !== 'credential_file_missing') result.skipped.push({ reason: snapshot.reason });
        continue;
      }
      const provider = source.provider || (snapshot.providers.length === 1 ? snapshot.providers[0]
        : snapshot.hostId === 'workbuddy-desktop' ? 'workbuddycn' : 'codebuddycn');
      // Never classify an incorrectly named regional App file as another App.
      if (!codebuddyCredentialPaths(hostHomeDir, provider).some(file => path.basename(file, '.info') === snapshot.hostId)) {
        result.skipped.push({ reason: 'credential_source_mismatch' }); continue;
      }
      try {
        const targets = [source.accountRef ? { provider, accountRef: source.accountRef } : { provider },
          ...records.filter(record => record.provider !== provider
            && inspectCodebuddyCredential(record.nativeAuth?.credentials, record.provider).scope === snapshot.scope)];
        for (const target of targets) {
          const outcome = adoptCodebuddyCredential(fs, aiHomeDir, target.provider, snapshot.credential, {
            accountRef: target.accountRef, automatic: true,
            hostId: target.provider === provider ? snapshot.hostId : target.nativeAuth?.codebuddyCredentialHostId
          });
          if (outcome.updated) { result.updated.push(outcome); pending.set(outcome.accountRef, outcome); }
          else if (!['unchanged', 'older_credential'].includes(outcome.reason)) result.skipped.push({ reason: outcome.reason, accountRef: outcome.accountRef });
        }
      } catch (error) { result.skipped.push({ reason: error.code === 'account_deleted_by_user' ? error.code : 'credential_adoption_failed' }); }
    }
    last = result; return result;
  }
  function start(callbacks = {}) {
    if (timer) return; stopped = false;
    const tick = () => {
      if (stopped) return;
      try {
        scan();
        if (pending.size && callbacks.onUpdated) { callbacks.onUpdated([...pending.values()]); pending.clear(); }
      } catch (_) { callbacks.onError?.('codebuddy_native_sync_failed'); }
    };
    tick(); timer = (options.setInterval || setInterval)(tick, Math.max(1000, callbacks.intervalMs || 5000)); timer?.unref?.();
  }
  function stop() { stopped = true; if (timer) (options.clearInterval || clearInterval)(timer); timer = null; }
  return { scan, start, stop, getStats: () => ({ scanned: last.scanned, updated: last.updated.length, skipped: last.skipped, pending: pending.size }) };
}
module.exports = { adoptCodebuddyCredential, createCodebuddyNativeCredentialSync };
