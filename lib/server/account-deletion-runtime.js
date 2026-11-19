'use strict';

// Go owns deletion. This bridge only inspects Node-owned handles and executes
// explicit release/preparation requests; it never calls a public delete route.
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { resolveGoServerBinary } = require('../cli/services/server/go-core-supervisor');
const fs = require('node:fs');
const path = require('node:path');
const { resolveAiHomeDir } = require('../runtime/aih-home');
const { ensureDurableDirectory, syncDirectory } = require('../runtime/durable-directory');
const { writeMaintenanceOwner } = require('../runtime/maintenance-owner-file');
const runStore = require('./native-chat-run-store');
const { isAccountRef } = require('../account/public-account-ref');
const { isKnownProvider } = require('../provider-catalog');
const { credentialsEqual, isDirectLoopbackRequest, parseBearerCredential } = require('./management-key-auth');

const INTERNAL_PATH = '/v0/internal/accounts/deletion-runtime';
const LEASE_MS = 60_000;
const EXIT_WAIT_MS = 5_000;
const MAX_LEASES = 128;
const MAX_RESOURCES = 256;
const leases = new Map();
const deleting = new Map();
const actions = new Set(['inspect', 'begin', 'release', 'prepare', 'renew', 'recover', 'complete', 'cancel']);
const RECOVERY_PATH = '/v1/management/webui/account-deletion-runtime/recovery';
const loadedHomes = new Set();
let restoring = false;
let recoveryContext = null;
let recoveryTimer = null;
let recovering = false;

function failure(code, status = 503) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function accountKey(provider, accountRef) {
  return `${provider}\0${accountRef}`;
}

function readState(provider, accountRef) {
  const runs = runStore.snapshotNativeAccountRuns(provider, accountRef);
  if (runs.length > MAX_RESOURCES) throw failure('account_runtime_unverifiable');
  return { runs };
}

// Timers are only the background fallback. Every operation also reaps expired
// leases synchronously, including the owner/gates, before checking conflicts.
function reapExpiredLeases() {
  const now = Date.now();
  for (const lease of leases.values()) {
    if (!lease.prepared && lease.expiresAt <= now) disposeLease(lease);
  }
}

function validateLease(payload) {
  reapExpiredLeases();
  const lease = typeof payload.lease === 'string' && leases.get(payload.lease);
  if (!lease || lease.provider !== payload.provider || lease.accountRef !== payload.accountRef ||
    (!lease.prepared && lease.expiresAt <= Date.now())) throw failure('account_deletion_lease_invalid');
  return lease;
}

function disposeLease(lease) {
  if (leases.get(lease.token) !== lease) return;
  if (lease.marker) {
    if (process.platform === 'win32') persistWindowsMarker('remove', lease);
    else {
      try { fs.unlinkSync(lease.marker); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      syncDirectory(fs, path.dirname(lease.marker));
    }
  }
  clearTimeout(lease.timer);
  leases.delete(lease.token);
  const key = accountKey(lease.provider, lease.accountRef);
  if (deleting.get(key) === lease.token) deleting.delete(key);
  runStore.endNativeAccountDeletion(lease.token);
}


// Windows cannot fsync a directory through Node. The installed Go component
// owns the private write-through publication; no shell or caller path is used.
function persistWindowsMarker(action, lease) {
  const result = spawnSync(resolveGoServerBinary({}), ['__account-deletion-marker'], {
    input: JSON.stringify({ action, record: {
      version: 1, prepared: true, token: lease.token, provider: lease.provider, accountRef: lease.accountRef
    } }),
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, AIH_HOME_DIR: lease.home },
    stdio: ['pipe', 'ignore', 'pipe']
  });
  if (result.error || result.status !== 0) throw failure('account_deletion_marker_unavailable');
}

function markerDirectory(home, create = false) {
  const root = path.resolve(resolveAiHomeDir({ aiHomeDir: home }));
  const run = path.join(root, 'run');
  const directory = path.join(run, 'account-deletion-prepared');
  if (create) {
    ensureDurableDirectory(fs, run, root);
    ensureDurableDirectory(fs, directory, run);
  }
  return { root, directory };
}

// Restore before launch admission, without relying on wall time or process PID.
// Only Go's canonical result query can release these recovered fences.
function restorePreparedGates(home) {
  if (restoring) return;
  const { root, directory } = markerDirectory(home);
  if (loadedHomes.has(root)) return;
  restoring = true;
  try {
    let names;
    try {
      const dir = fs.lstatSync(directory);
      if (!dir.isDirectory() || dir.isSymbolicLink() ||
        (process.platform !== 'win32' && (dir.mode & 0o077) !== 0)) throw failure('account_deletion_recovery_required');
      names = fs.readdirSync(directory);
      if (names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length > MAX_LEASES) {
        throw failure('account_deletion_recovery_required');
      }
    } catch (error) {
      if (error.code === 'ENOENT') { loadedHomes.add(root); return; }
      throw error;
    }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const marker = path.join(directory, name);
      const info = fs.lstatSync(marker);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096 ||
        (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
        throw failure('account_deletion_recovery_required');
      }
      const record = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (record.version !== 1 || record.prepared !== true || `${record.token}.json` !== name ||
        typeof record.provider !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(record.provider) ||
        !isKnownProvider(record.provider) || typeof record.accountRef !== 'string' || !isAccountRef(record.accountRef)) {
        throw failure('account_deletion_recovery_required');
      }
      if (leases.has(record.token)) continue;
      const lease = { ...record, home: root, marker, runs: [], writers: [], begun: true, recovered: true, busy: false };
      leases.set(lease.token, lease);
      deleting.set(accountKey(lease.provider, lease.accountRef), lease.token);
      runStore.beginNativeAccountDeletion(lease.provider, lease.accountRef, lease.token, 0);
      runStore.pinNativeAccountDeletion(lease.token);
    }
    loadedHomes.add(root);
  } finally { restoring = false; }
}

function pinPrepared(lease) {
  // Pin before any await and before replying success. Failure leaves the live
  // fence in place; Go finally can cancel only after its operation has stopped.
  lease.prepared = true;
  clearTimeout(lease.timer);
  runStore.pinNativeAccountDeletion(lease.token);
  if (process.platform === 'win32') {
    persistWindowsMarker('write', lease);
    lease.marker = path.join(markerDirectory(lease.home).directory, `${lease.token}.json`);
  } else {
    const { directory } = markerDirectory(lease.home, true);
    lease.marker = path.join(directory, `${lease.token}.json`);
    writeMaintenanceOwner(fs, lease.marker, {
      version: 1, prepared: true, token: lease.token, provider: lease.provider, accountRef: lease.accountRef
    });
  }
}

async function recoverPrepared(lease, ctx) {
  const client = ctx && ctx.deps && ctx.deps.goCoreSync;
  if (leases.get(lease.token) !== lease || !lease.prepared) throw failure('account_deletion_lease_invalid');
  if (!client || typeof client.webuiRequest !== 'function') throw failure('account_deletion_recovery_unavailable');
  let timer;
  let response;
  try {
    response = await Promise.race([
      client.webuiRequest({ method: 'POST', path: RECOVERY_PATH,
        body: { provider: lease.provider, accountRef: lease.accountRef, lease: lease.token } }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('account_deletion_recovery_unavailable')), 5000);
      })
    ]);
  } finally { clearTimeout(timer); }
  const result = response && response.data;
  if (!response || response.status !== 200 || !response.ok || !result || !result.ok ||
    result.provider !== lease.provider || result.accountRef !== lease.accountRef || result.lease !== lease.token) {
    throw failure('account_deletion_recovery_unavailable');
  }
  if (!['committed', 'aborted'].includes(result.state)) throw failure('account_deletion_recovery_pending');
  disposeLease(lease);
  return { ok: true, occupants: [], recovered: result.state };
}

function configureRecovery(ctx) {
  restorePreparedGates(ctx.aiHomeDir || (ctx.deps && ctx.deps.aiHomeDir));
  recoveryContext = { deps: { goCoreSync: ctx.deps && ctx.deps.goCoreSync } };
  if (recoveryTimer) return;
  recoveryTimer = setInterval(async () => {
    if (recovering) return;
    recovering = true;
    try {
      for (const lease of leases.values()) {
        if (!lease.prepared || lease.busy) continue;
        try { await recoverPrepared(lease, recoveryContext); } catch (_error) { /* pending/unknown never unlock */ }
      }
    } finally { recovering = false; }
  }, 5000);
  recoveryTimer.unref();
}

function createLease(payload, home) {
  reapExpiredLeases();
  if (leases.size >= MAX_LEASES) throw failure('account_deletion_lease_capacity');
  const ownedToken = deleting.get(accountKey(payload.provider, payload.accountRef));
  const owned = ownedToken && leases.get(ownedToken);
  if (owned && owned.prepared) throw failure('account_deletion_recovery_required');
  const state = readState(payload.provider, payload.accountRef);
  const lease = {
    token: crypto.randomBytes(32).toString('hex'),
    home: markerDirectory(home).root,
    prepared: false,
    provider: payload.provider,
    accountRef: payload.accountRef,
    expiresAt: Date.now() + LEASE_MS,
    runs: state.runs,
    writers: [],
    begun: false,
    busy: false
  };
  lease.timer = setTimeout(() => disposeLease(lease), LEASE_MS);
  lease.timer.unref();
  leases.set(lease.token, lease);
  return lease;
}

function currentState(lease) {
  validateLease({ provider: lease.provider, accountRef: lease.accountRef, lease: lease.token });
  if (lease.begun && runStore.nativeAccountDeletionChanged(lease.token)) {
    throw failure('account_deletion_snapshot_changed');
  }
  const state = readState(lease.provider, lease.accountRef);
  if (state.runs.some((run) => !lease.runs.some((prior) => prior.run === run.run && prior.child === run.child))) {
    throw failure('account_deletion_snapshot_changed');
  }
  return state;
}

function occupants(lease, state) {
  const items = [];
  // Retained references matter even when an older public abort endpoint has
  // already unregistered the run. Registry disappearance is not exit evidence.
  for (const run of lease.runs) {
    const exit = runStore.inspectNativeRunExit(run);
    // Unknown must reach Go's preflight before any owner's force release.
    if (!exit.verifiable) throw failure('account_runtime_unverifiable');
    if (exit.exited) continue;
    items.push({
      kind: 'native_session', label: '运行中的会话',
      provider: lease.provider, accountRef: lease.accountRef,
      session: run.session, detail: run.runId
    });
  }
  return items;
}

function begin(lease) {
  reapExpiredLeases();
  validateLease({ provider: lease.provider, accountRef: lease.accountRef, lease: lease.token });
  const key = accountKey(lease.provider, lease.accountRef);
  const current = deleting.get(key);
  if (current && current !== lease.token) throw failure('account_deletion_in_progress', 409);
  if (!lease.begun) {
    runStore.beginNativeAccountDeletion(lease.provider, lease.accountRef, lease.token, lease.expiresAt);
    deleting.set(key, lease.token);
    lease.begun = true;
  }
}

async function releaseRuns(lease) {
  const targets = lease.runs.filter((run) => !runStore.inspectNativeRunExit(run).exited);
  // Preflight every handle before aborting any of them. Ordinary `done`, abort
  // return values and unregister() are deliberately not accepted as evidence.
  for (const target of targets) {
    if (!runStore.inspectNativeRunExit(target).verifiable || typeof target.abort !== 'function' || target.run.abort !== target.abort) {
      throw failure('account_runtime_unverifiable');
    }
  }
  const deadline = Math.min(Date.now() + EXIT_WAIT_MS, lease.expiresAt);
  for (const target of targets) {
    validateLease({ provider: lease.provider, accountRef: lease.accountRef, lease: lease.token });
    if (runStore.inspectNativeRunExit(target).exited) continue;
    try {
      if (target.run.abort !== target.abort) throw failure('account_deletion_snapshot_changed');
      const result = target.abort.call(target.run);
      if (result && typeof result.then === 'function') {
        let timer;
        try {
          await Promise.race([
            result,
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(failure('account_runtime_release_unconfirmed')), Math.max(1, deadline - Date.now()));
            })
          ]);
        } finally { clearTimeout(timer); }
      }
    } catch (_error) { throw failure('account_runtime_release_failed'); }
  }
  while (targets.some((target) => !runStore.inspectNativeRunExit(target).exited)) {
    validateLease({ provider: lease.provider, accountRef: lease.accountRef, lease: lease.token });
    if (Date.now() >= deadline) throw failure('account_runtime_release_unconfirmed');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function execute(payload, ctx) {
  reapExpiredLeases();
  if (payload.action === 'complete' || payload.action === 'cancel') {
    const existing = leases.get(payload.lease);
    if (existing) {
      if (existing.provider !== payload.provider || existing.accountRef !== payload.accountRef) {
        throw failure('account_deletion_lease_invalid');
      }
      // A timed-out HTTP caller must not unpin preparation still running in
      // Node. Finally can retry, or canonical recovery resolves it afterwards.
      if (existing.busy) throw failure('account_deletion_in_progress', 409);
      disposeLease(existing);
    }
    return { ok: true, occupants: [] };
  }
  const lease = payload.lease ? validateLease(payload) :
    (payload.action === 'inspect' || payload.action === 'begin' ? createLease(payload, ctx.aiHomeDir || (ctx.deps && ctx.deps.aiHomeDir)) : null);
  if (!lease) throw failure('account_deletion_lease_required');
  if (lease.busy) throw failure('account_deletion_in_progress', 409);
  if (payload.action === 'recover') {
    if (!lease.prepared) throw failure('account_deletion_lease_invalid');
    return recoverPrepared(lease, ctx);
  }
  if (lease.recovered) throw failure('account_deletion_recovery_required');
  if (payload.action === 'renew') {
    if (!lease.prepared) {
      lease.expiresAt = Date.now() + LEASE_MS;
      clearTimeout(lease.timer);
      lease.timer = setTimeout(() => disposeLease(lease), LEASE_MS);
      lease.timer.unref();
      if (lease.begun) {
        runStore.renewNativeAccountDeletion(lease.token, lease.expiresAt);
      }
    }
    return { ok: true, occupants: [], lease: lease.token, prepared: lease.prepared, expiresAt: lease.prepared ? null : lease.expiresAt };
  }
  let state;
  try {
    state = currentState(lease);
    const items = occupants(lease, state);
    if (payload.action === 'begin') begin(lease);
    if (payload.action === 'inspect' || payload.action === 'begin') {
      return { ok: true, occupants: items, lease: lease.token, prepared: lease.prepared, expiresAt: lease.prepared ? null : lease.expiresAt };
    }
  } catch (error) {
    if (!payload.lease) disposeLease(lease);
    throw error;
  }
  if (!lease.begun) throw failure('account_deletion_begin_required');
  lease.busy = true;
  try {
    if (payload.action === 'release') {
      await releaseRuns(lease);
      currentState(lease);
    }
    state = currentState(lease);
    const remaining = occupants(lease, state);
    if (remaining.length) {
      return { ok: false, error: 'account_runtime_active', message: '账号写入者尚未退出', occupants: remaining, lease: lease.token };
    }
    if (payload.action === 'prepare' && !lease.prepared) pinPrepared(lease);
    return { ok: true, occupants: [], lease: lease.token, prepared: lease.prepared, expiresAt: lease.prepared ? null : lease.expiresAt };
  } finally {
    lease.busy = false;
  }
}

function writeJSON(response, status, body) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(body));
}

async function handleAccountDeletionRuntimeRequest(ctx) {
  if (ctx.pathname !== INTERNAL_PATH) {
    // The router visits this bridge before dispatching public Node routes. On
    // the first request after restart, resume recovery without waiting for a
    // user to retry deletion; admission itself still fails closed on bad files.
    try { configureRecovery(ctx); } catch (_error) { /* launch admission reports the fence error */ }
    return false;
  }
  if (!isDirectLoopbackRequest(ctx.req)) {
    writeJSON(ctx.res, 403, { ok: false, occupants: [], error: 'deletion_internal_loopback_required' });
    return true;
  }
  const configuredKey = ctx.deps && ctx.deps.goCoreManagementKey;
  let key = '';
  try { key = typeof configuredKey === 'function' ? configuredKey() : configuredKey; } catch (_error) { /* fail closed */ }
  if (!key || !credentialsEqual(parseBearerCredential(ctx.req), key)) {
    writeJSON(ctx.res, 401, { ok: false, occupants: [], error: 'deletion_internal_unauthorized' });
    return true;
  }
  if (ctx.method !== 'POST') {
    ctx.res.setHeader('allow', 'POST');
    writeJSON(ctx.res, 405, { ok: false, occupants: [], error: 'method_not_allowed' });
    return true;
  }
  let payload;
  try {
    const body = await ctx.readRequestBody(ctx.req, { maxBytes: 4096 });
    payload = JSON.parse(body.toString('utf8'));
  } catch (_error) {
    writeJSON(ctx.res, 400, { ok: false, occupants: [], error: 'invalid_deletion_runtime_request' });
    return true;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
    Object.keys(payload).some((key) => !['action', 'provider', 'accountRef', 'lease'].includes(key)) ||
    !actions.has(payload.action) ||
    (!['inspect', 'begin'].includes(payload.action) && typeof payload.lease !== 'string') ||
    typeof payload.provider !== 'string' ||
    !/^[a-z][a-z0-9-]{0,47}$/.test(payload.provider) || !isKnownProvider(payload.provider) ||
    typeof payload.accountRef !== 'string' || payload.accountRef !== payload.accountRef.trim() || !isAccountRef(payload.accountRef) ||
    (payload.lease !== undefined && (typeof payload.lease !== 'string' || !/^[a-f0-9]{64}$/.test(payload.lease)))) {
    writeJSON(ctx.res, 400, { ok: false, occupants: [], error: 'invalid_deletion_runtime_request' });
    return true;
  }
  try {
    configureRecovery(ctx);
    const result = await execute(payload, ctx);
    writeJSON(ctx.res, result.ok ? 200 : 409, result);
  } catch (error) {
    const code = error && typeof error.code === 'string' && /^account_[a-z_]+$/.test(error.code)
      ? error.code : 'account_runtime_unverifiable';
    writeJSON(ctx.res, Number(error && error.status) === 409 ? 409 : 503, {
      ok: false, occupants: [], error: code, message: '无法确认账号运行时已安全退出',
      ...(payload.lease ? { lease: payload.lease } : {})
    });
  }
  return true;
}

module.exports = { INTERNAL_PATH, handleAccountDeletionRuntimeRequest, restorePreparedGates };
