'use strict';

const nodePath = require('node:path');
const { inspectCodexCredential, compareCodexCredentialSnapshots, codexCredentialFingerprint } = require('./codex-credential-freshness');
const MAX_AUTH_BYTES = 1024 * 1024;
const DEFAULT_INTERVAL_MS = 3000;

function createCodexNativeCredentialSync(deps = {}) {
  const fs = deps.fs;
  const path = deps.path || nodePath;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const hostHomeDir = String(deps.hostHomeDir || '').trim();
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const store = deps.store || require('../server/account-credential-store');
  const identify = deps.resolveIdentity || require('./account-identity').resolveNativeAuthIdentitySeed;
  const register = deps.registerIdentity || require('./account-registration').registerAccountIdentity;
  const insert = deps.insertIfMissing || require('../server/account-credential-store-insert').insertAccountNativeAuthIfMissing;
  const setIntervalImpl = deps.setInterval || setInterval;
  const clearIntervalImpl = deps.clearInterval || clearInterval;
  let timer = null;
  let running = false;
  let stopped = false;
  let lastScan = { updated: [], skipped: [], scanned: 0 };
  const pending = new Map();
  const sourceCache = new Map();

  function identityOf(auth) {
    const value = identify('codex', { auth });
    return value && !value.degraded && value.kind === 'oauth' ? String(value.identitySeed || '') : '';
  }
  function readSnapshot(filePath) {
    try {
      const before = fs.lstatSync(filePath);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_AUTH_BYTES) return { reason: 'unsupported_auth_file' };
      const stamp = [before.ino, before.size, before.mtimeMs, before.ctimeMs].join(':');
      const cached = sourceCache.get(filePath);
      if (cached && cached.stamp === stamp) return cached.snapshot;
      const raw = fs.readFileSync(filePath, 'utf8');
      const after = fs.lstatSync(filePath);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        return { reason: 'auth_file_changed_during_read' };
      }
      if (Buffer.byteLength(raw) > MAX_AUTH_BYTES) return { reason: 'auth_file_too_large' };
      const auth = JSON.parse(raw);
      const inspection = inspectCodexCredential(auth, now());
      if (!inspection.usable) return { reason: inspection.reason };
      const identitySeed = identityOf(auth);
      if (!identitySeed) return { reason: 'stable_identity_unavailable' };
      const snapshot = { auth, identitySeed };
      sourceCache.set(filePath, { stamp, snapshot });
      return snapshot;
    } catch (error) {
      sourceCache.delete(filePath);
      return { reason: error && error.code === 'ENOENT' ? 'auth_file_missing' : 'auth_file_unreadable' };
    }
  }
  function sourcePaths(records, options) {
    if (Array.isArray(options.files)) return [...new Set(options.files.filter(value => typeof value === 'string' && path.isAbsolute(value)))];
    const files = [];
    const explicitHome = String(deps.nativeCodexHome || '').trim();
    if (explicitHome && path.isAbsolute(explicitHome)) files.push(path.join(explicitHome, 'auth.json'));
    else if (hostHomeDir) files.push(path.join(hostHomeDir, '.codex', 'auth.json'));
    // Only registered runtime roots; never recursively discover backups,
    // exports, session transcripts, or arbitrary credential-looking files.
    for (const record of records) {
      if (!/^acct_[a-f0-9]{20}$/.test(String(record.accountRef || ''))) continue;
      files.push(path.join(aiHomeDir, 'run', 'codex-desktop', record.accountRef, 'auth.json'));
      files.push(path.join(aiHomeDir, 'run', 'accounts', 'codex', record.accountRef, '.codex', 'auth.json'));
    }
    return [...new Set(files)];
  }
  function ingest(snapshot, matches) {
    if (matches.length > 1) return { reason: 'ambiguous_existing_identity' };
    const registration = matches.length ? { accountRef: matches[0].accountRef, created: false }
      : register(fs, aiHomeDir, { provider: 'codex', identitySeed: snapshot.identitySeed, respectDeletion: true });
    const accountRef = registration.accountRef;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = store.readAccountCredentialRecord(fs, aiHomeDir, accountRef);
      if (current && (current.provider !== 'codex' || String(current.env && current.env.OPENAI_API_KEY || '').trim())) {
        return { reason: 'account_mode_conflict' };
      }
      const currentAuth = current && current.nativeAuth && current.nativeAuth.auth;
      const currentIdentity = identityOf(currentAuth);
      if (currentIdentity && currentIdentity !== snapshot.identitySeed) return { reason: 'account_identity_conflict' };
      if (currentAuth && !currentIdentity && Object.keys(currentAuth).length) return { reason: 'database_identity_unknown' };
      const decision = compareCodexCredentialSnapshots(currentAuth, snapshot.auth, { nowMs: now() });
      if (!decision.adopt) return { accountRef, reason: decision.reason };
      const next = { ...(current && current.nativeAuth || {}), auth: snapshot.auth,
        codexNativeObservation: { capturedAt: now(), fingerprint: codexCredentialFingerprint(snapshot.auth) } };
      const saved = current
        ? store.compareAndSwapAccountNativeAuth(fs, aiHomeDir, accountRef, current, next)
        : insert(fs, aiHomeDir, accountRef, next);
      if (saved) {
        return { accountRef, updated: true, created: registration.created === true, reason: decision.reason };
      }
      // A competing token refresh/login won. Re-read and re-evaluate rather
      // than retrying an unconditional overwrite of a now-newer generation.
    }
    return { accountRef, reason: 'concurrent_credential_update' };
  }
  function scan(options = {}) {
    const result = { updated: [], skipped: [], scanned: 0 };
    if (!fs || !aiHomeDir || (!hostHomeDir && !deps.nativeCodexHome && !Array.isArray(options.files))) return result;
    let records;
    try { records = store.listAccountCredentialRecords(fs, aiHomeDir, 'codex'); }
    catch (_) { return { ...result, skipped: [{ reason: 'credential_store_unavailable' }] }; }
    const identities = new Map();
    for (const record of records) {
      if (record.provider !== 'codex' || String(record.env && record.env.OPENAI_API_KEY || '').trim()) continue;
      const identity = identityOf(record.nativeAuth && record.nativeAuth.auth);
      if (identity) identities.set(identity, [...(identities.get(identity) || []), record]);
    }
    const paths = sourcePaths(records, options);
    for (const cachedPath of sourceCache.keys()) if (!paths.includes(cachedPath)) sourceCache.delete(cachedPath);
    for (const filePath of paths) {
      result.scanned += 1;
      const snapshot = readSnapshot(filePath);
      if (!snapshot.auth) {
        if (snapshot.reason !== 'auth_file_missing') result.skipped.push({ reason: snapshot.reason });
        continue;
      }
      try {
        const outcome = ingest(snapshot, identities.get(snapshot.identitySeed) || []);
        if (outcome.updated) {
          result.updated.push(outcome);
          pending.set(outcome.accountRef, outcome);
          // Newly discovered identities participate in subsequent sources in
          // the same pass, including an older projection of the same account.
          identities.set(snapshot.identitySeed, [{ accountRef: outcome.accountRef }]);
        } else if (outcome.reason !== 'unchanged') result.skipped.push({ accountRef: outcome.accountRef, reason: outcome.reason });
      } catch (error) {
        result.skipped.push({ reason: error && error.code === 'account_deleted_by_user'
          ? 'account_deleted_by_user' : 'credential_adoption_failed' });
      }
    }
    lastScan = result;
    return result;
  }
  function start(options = {}) {
    if (timer) return;
    stopped = false;
    const tick = () => {
      if (running || stopped) return;
      running = true;
      try {
        scan();
        if (pending.size && typeof options.onUpdated === 'function') {
          const events = [...pending.values()];
          // Synchronous callback by contract (runtime reload is synchronous).
          // Keep notifications queued when reload throws, even if files no
          // longer change after the successful database write.
          options.onUpdated(events);
          for (const event of events) pending.delete(event.accountRef);
        }
      } catch (_) {
        if (typeof options.onError === 'function') options.onError('native_credential_sync_failed');
      } finally { running = false; }
    };
    tick();
    timer = setIntervalImpl(tick, Math.max(1000, Number(options.intervalMs) || DEFAULT_INTERVAL_MS));
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function stop() {
    stopped = true;
    if (timer) clearIntervalImpl(timer);
    timer = null;
  }
  return { scan, start, stop, getStats: () => ({ scanned: lastScan.scanned, updated: lastScan.updated.length, skipped: lastScan.skipped, pending: pending.size }) };
}
module.exports = { createCodexNativeCredentialSync };
