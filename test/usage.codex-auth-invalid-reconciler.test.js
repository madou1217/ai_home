const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createCodexAuthInvalidReconciler
} = require('../lib/cli/services/usage/codex-auth-invalid-reconciler');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { resolveAccountRef } = require('../lib/server/account-ref-store');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { createAccountStateService } = require('../lib/account/state-service');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-auth-reconcile-'));
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function registerCodexAccount(root, cliAccountId, tokens = null, options = {}) {
  const accountRef = registerAccountIdentity(fs, root, {
    provider: 'codex',
    cliAccountId,
    identitySeed: `oauth:codex:reconcile-${cliAccountId}@example.com`
  }).accountRef;
  if (tokens) writeAccountNativeAuth(fs, root, accountRef, { auth: { tokens } });
  const runtimeDir = resolveAccountRuntimeDir(root, 'codex', accountRef);
  if (options.createRuntime !== false) fs.mkdirSync(runtimeDir, { recursive: true });
  return { accountRef, runtimeDir };
}

function makeService(root, overrides = {}) {
  const deletedStates = [];
  const clearedRuntime = [];
  const deletedEvents = [];
  const retainedRuntime = [];
  const statusUpdates = [];
  const scheduled = [];
  const service = createCodexAuthInvalidReconciler({
    fs,
    path,
    aiHomeDir: root,
    processObj: { env: {}, nextTick: (fn) => scheduled.push(fn) },
    accountStateService: {
      deleteAccount(accountRef) {
        deletedStates.push(accountRef);
        return true;
      },
      getAccountState(accountRef) {
        return {
          accountRef,
          provider: 'codex',
          status: 'up',
          configured: true,
          apiKeyMode: false,
          authMode: 'oauth',
          displayName: 'retained@example.com',
          runtimeState: {
            successCount: 2,
            failCount: 1
          }
        };
      },
      recordRuntimeFailure(accountRef, provider, runtimeState, baseState) {
        retainedRuntime.push({ accountRef, provider, runtimeState, baseState });
        return true;
      },
      setOperationalStatus(accountRef, provider, status, baseState) {
        statusUpdates.push({ accountRef, provider, status, baseState });
        return true;
      },
      clearRuntimeBlock(accountRef, provider, options) {
        clearedRuntime.push({ accountRef, provider, options });
        return true;
      }
    },
    fetchWithTimeout: async () => ({
      ok: true,
      text: async () => '{}'
    }),
    ensureSessionStoreLinks: () => ({ migrated: 0, linked: 0 }),
    ...overrides
  });
  if (typeof service.onAccountDeleted === 'function') {
    service.onAccountDeleted((event) => {
      deletedEvents.push(event);
    });
  }
  return {
    service,
    deletedStates,
    clearedRuntime,
    deletedEvents,
    retainedRuntime,
    statusUpdates,
    scheduled,
    async runScheduled() {
      while (scheduled.length > 0) {
        const fn = scheduled.shift();
        fn();
        await Promise.resolve();
      }
      await service.waitForIdle();
    }
  };
}

function assertRetained(ctx, root, accountRef, reason) {
  assert.ok(resolveAccountRef(fs, root, accountRef));
  assert.deepEqual(ctx.deletedStates, []);
  assert.deepEqual(ctx.deletedEvents, []);
  assert.equal(ctx.retainedRuntime.length, 1);
  assert.equal(ctx.retainedRuntime[0].accountRef, accountRef);
  assert.equal(ctx.retainedRuntime[0].provider, 'codex');
  assert.equal(ctx.retainedRuntime[0].runtimeState.lastFailureKind, 'auth_invalid');
  assert.equal(
    ctx.retainedRuntime[0].runtimeState.lastFailureReason,
    `account_recovery_required:${reason}`
  );
  assert.ok(ctx.retainedRuntime[0].runtimeState.authInvalidUntil > Date.now());
  assert.equal(ctx.statusUpdates.length, 1);
  assert.equal(ctx.statusUpdates[0].accountRef, accountRef);
  assert.equal(ctx.statusUpdates[0].status, 'down');
}

test('codex auth invalid reconciler retains direct usage 401 asynchronously', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { accountRef, runtimeDir } = registerCodexAccount(root, '1');
  const ctx = makeService(root);

  const queued = ctx.service.enqueueDirectHttpStatus401('codex', accountRef, 'direct_http_status_401');

  assert.equal(queued, true);
  assert.equal(fs.existsSync(runtimeDir), true);
  assert.deepEqual(ctx.deletedStates, []);

  await ctx.runScheduled();

  assert.equal(fs.existsSync(runtimeDir), true);
  assertRetained(ctx, root, accountRef, 'direct_http_status_401');
});

test('codex auth invalid reconciler persists retained recovery state without removing credentials', async (t) => {
  const root = mkTmpDir();
  let accountStateIndex = null;
  t.after(() => {
    if (accountStateIndex) accountStateIndex.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { accountRef, runtimeDir } = registerCodexAccount(root, '11', {
    access_token: makeJwt({ client_id: 'app_test' }),
    refresh_token: 'rt_keep',
    account_id: 'acc_keep'
  });
  accountStateIndex = createAccountStateIndex({ fs, aiHomeDir: root });
  accountStateIndex.upsertAccountState(accountRef, 'codex', {
    status: 'up',
    configured: true,
    apiKeyMode: false,
    authMode: 'oauth-browser',
    displayName: 'persisted@example.com'
  });
  const accountStateService = createAccountStateService({ accountStateIndex });
  const ctx = makeService(root, { accountStateService });

  ctx.service.enqueueDirectHttpStatus401('codex', accountRef, 'direct_http_status_401');
  await ctx.runScheduled();

  const persisted = accountStateIndex.getAccountState(accountRef);
  assert.equal(persisted.status, 'down');
  assert.equal(persisted.configured, true);
  assert.equal(persisted.authMode, 'oauth-browser');
  assert.equal(persisted.runtimeState.lastFailureKind, 'auth_invalid');
  assert.equal(
    persisted.runtimeState.lastFailureReason,
    'account_recovery_required:direct_http_status_401'
  );
  assert.ok(persisted.runtimeState.authInvalidUntil > Date.now());
  assert.deepEqual(accountStateIndex.listConfiguredRefs('codex'), []);
  assert.ok(resolveAccountRef(fs, root, accountRef));
  assert.equal(fs.existsSync(runtimeDir), true);
  assert.equal(
    readAccountNativeAuth(fs, root, accountRef).auth.tokens.refresh_token,
    'rt_keep'
  );
});

test('codex auth invalid reconciler retains auth-invalid account without refresh token', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { accountRef, runtimeDir } = registerCodexAccount(root, '2', {
    access_token: makeJwt({
      'https://api.openai.com/profile': { email: 'missing-refresh@example.com' }
    })
  });
  const ctx = makeService(root);

  ctx.service.enqueueAuthInvalidReauthRequired('codex', accountRef, 'auth_invalid_reauth_required');
  await ctx.runScheduled();

  assert.equal(fs.existsSync(runtimeDir), true);
  assertRetained(ctx, root, accountRef, 'auth_invalid_missing_refresh_token');
});

test('codex auth invalid reconciler retains account identity when runtime projection is already missing', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { accountRef, runtimeDir } = registerCodexAccount(root, '20', null, { createRuntime: false });
  const ctx = makeService(root);

  ctx.service.enqueueDirectHttpStatus401('codex', accountRef, 'direct_http_status_401');
  await ctx.runScheduled();

  assert.equal(fs.existsSync(runtimeDir), false);
  assertRetained(ctx, root, accountRef, 'direct_http_status_401');
});

test('codex auth invalid reconciler retains provider resources without cleanup reconciliation', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { accountRef, runtimeDir } = registerCodexAccount(root, '21');
  const resourcePath = path.join(runtimeDir, '.codex', 'sessions', 'late-session.jsonl');
  fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
  fs.writeFileSync(resourcePath, '{"kept":true}\n', 'utf8');
  const reconciliations = [];
  const ctx = makeService(root, {
    ensureSessionStoreLinks(provider, resolvedRef) {
      reconciliations.push({ provider, accountRef: resolvedRef });
      return { migrated: 0, linked: 0, unresolved: ['sessions'] };
    }
  });

  ctx.service.enqueueDirectHttpStatus401('codex', accountRef, 'direct_http_status_401');
  await ctx.runScheduled();

  assert.deepEqual(reconciliations, []);
  assert.equal(fs.readFileSync(resourcePath, 'utf8'), '{"kept":true}\n');
  assertRetained(ctx, root, accountRef, 'direct_http_status_401');
});

test('codex auth invalid reconciler clears runtime when refresh succeeds', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { accountRef, runtimeDir } = registerCodexAccount(root, '3', {
    access_token: makeJwt({ client_id: 'app_test' }),
    refresh_token: 'rt_ok',
    account_id: 'acc_3'
  });
  const refreshCalls = [];
  const ctx = makeService(root, {
    refreshCodexAccessToken: async (account, options) => {
      refreshCalls.push({ account, options });
      return { ok: true, refreshed: true, reason: 'refreshed' };
    }
  });

  ctx.service.enqueueAuthInvalidReauthRequired('codex', accountRef, 'auth_invalid_reauth_required');
  await ctx.runScheduled();

  assert.equal(fs.existsSync(runtimeDir), true);
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].account.refreshToken, 'rt_ok');
  assert.equal(refreshCalls[0].options.force, true);
  assert.deepEqual(ctx.deletedStates, []);
  assert.deepEqual(ctx.deletedEvents, []);
  assert.deepEqual(ctx.retainedRuntime, []);
  assert.deepEqual(ctx.statusUpdates, []);
  assert.equal(ctx.clearedRuntime.length, 1);
  assert.equal(ctx.clearedRuntime[0].accountRef, accountRef);
  assert.equal(ctx.clearedRuntime[0].options.evidence, 'token_refresh_success');
});

test('codex auth invalid reconciler retains normalized direct usage 401 without refreshing', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { accountRef, runtimeDir } = registerCodexAccount(root, '30', {
    access_token: makeJwt({ client_id: 'app_test' }),
    refresh_token: 'rt_direct_401',
    account_id: 'acc_30'
  });
  const refreshCalls = [];
  const ctx = makeService(root, {
    refreshCodexAccessToken: async (account, options) => {
      refreshCalls.push({ account, options });
      return { ok: true, refreshed: true, reason: 'refreshed' };
    }
  });

  ctx.service.enqueueUsageProbeFailure(
    'codex',
    accountRef,
    'auth_invalid_reauth_required:direct_http_status_401'
  );
  await ctx.runScheduled();

  assert.equal(fs.existsSync(runtimeDir), true);
  assert.equal(refreshCalls.length, 0);
  assertRetained(ctx, root, accountRef, 'auth_invalid_reauth_required:direct_http_status_401');
  assert.equal(ctx.clearedRuntime.length, 0);
});

test('codex auth invalid reconciler retains account when refresh reports terminated session', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { accountRef, runtimeDir } = registerCodexAccount(root, '4', {
    access_token: makeJwt({ client_id: 'app_test' }),
    refresh_token: 'rt_dead'
  });
  const ctx = makeService(root, {
    refreshCodexAccessToken: async () => ({
      ok: false,
      refreshed: false,
      reason: 'refresh_http_400',
      detail: '{"error":"app_session_terminated","error_description":"Your session has ended. Please log in again."}'
    })
  });

  ctx.service.enqueueAuthInvalidReauthRequired('codex', accountRef, 'auth_invalid_reauth_required');
  await ctx.runScheduled();

  assert.equal(fs.existsSync(runtimeDir), true);
  assertRetained(ctx, root, accountRef, 'refresh_http_400');
});

test('codex auth invalid reconciler keeps account when refresh failure is not session invalid', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { accountRef, runtimeDir } = registerCodexAccount(root, '5', {
    access_token: makeJwt({ client_id: 'app_test' }),
    refresh_token: 'rt_transient'
  });
  const ctx = makeService(root, {
    refreshCodexAccessToken: async () => ({
      ok: false,
      refreshed: false,
      reason: 'refresh_exception',
      detail: 'ECONNRESET'
    })
  });

  ctx.service.enqueueAuthInvalidReauthRequired('codex', accountRef, 'auth_invalid_reauth_required');
  await ctx.runScheduled();

  assert.equal(fs.existsSync(runtimeDir), true);
  assert.deepEqual(ctx.deletedStates, []);
  assert.deepEqual(ctx.deletedEvents, []);
  assert.deepEqual(ctx.retainedRuntime, []);
  assert.deepEqual(ctx.statusUpdates, []);
  assert.deepEqual(ctx.clearedRuntime, []);
});

test('codex auth invalid reconciler deduplicates pending account work', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { accountRef } = registerCodexAccount(root, '6', {
    access_token: makeJwt({ client_id: 'app_test' }),
    refresh_token: 'rt_once'
  });
  let refreshCount = 0;
  const ctx = makeService(root, {
    refreshCodexAccessToken: async () => {
      refreshCount += 1;
      return { ok: true, refreshed: true, reason: 'refreshed' };
    }
  });

  assert.equal(ctx.service.enqueueAuthInvalidReauthRequired('codex', accountRef, 'auth_invalid_reauth_required'), true);
  assert.equal(ctx.service.enqueueAuthInvalidReauthRequired('codex', accountRef, 'auth_invalid_reauth_required'), false);
  await ctx.runScheduled();

  assert.equal(refreshCount, 1);
  assert.equal(ctx.clearedRuntime.length, 1);
});
