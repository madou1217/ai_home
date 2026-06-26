const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createCodexAuthInvalidReconciler
} = require('../lib/cli/services/usage/codex-auth-invalid-reconciler');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-auth-reconcile-'));
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function writeAuth(root, id, tokens = {}) {
  const authDir = path.join(root, 'profiles', 'codex', String(id), '.codex');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'auth.json'), `${JSON.stringify({ tokens }, null, 2)}\n`);
}

function makeService(root, overrides = {}) {
  const deletedStates = [];
  const clearedRuntime = [];
  const deletedEvents = [];
  const scheduled = [];
  const service = createCodexAuthInvalidReconciler({
    fs,
    path,
    processObj: { env: {}, nextTick: (fn) => scheduled.push(fn) },
    getProfileDir: (_provider, id) => path.join(root, 'profiles', 'codex', String(id)),
    getToolConfigDir: (_provider, id) => path.join(root, 'profiles', 'codex', String(id), '.codex'),
    accountStateService: {
      deleteAccount(provider, id) {
        deletedStates.push({ provider, id });
        return true;
      },
      clearRuntimeBlock(provider, id, options) {
        clearedRuntime.push({ provider, id, options });
        return true;
      }
    },
    fetchWithTimeout: async () => ({
      ok: true,
      text: async () => '{}'
    }),
    ...overrides
  });
  service.onAccountDeleted((event) => {
    deletedEvents.push(event);
  });
  return {
    service,
    deletedStates,
    clearedRuntime,
    deletedEvents,
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

test('codex auth invalid reconciler deletes direct usage 401 asynchronously', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'profiles', 'codex', '1'), { recursive: true });
  const ctx = makeService(root);

  const queued = ctx.service.enqueueDirectHttpStatus401('codex', '1', 'direct_http_status_401');

  assert.equal(queued, true);
  assert.equal(fs.existsSync(path.join(root, 'profiles', 'codex', '1')), true);
  assert.deepEqual(ctx.deletedStates, []);

  await ctx.runScheduled();

  assert.equal(fs.existsSync(path.join(root, 'profiles', 'codex', '1')), false);
  assert.deepEqual(ctx.deletedStates, [{ provider: 'codex', id: '1' }]);
  assert.deepEqual(ctx.deletedEvents, [
    { provider: 'codex', accountId: '1', reason: 'direct_http_status_401' }
  ]);
});

test('codex auth invalid reconciler deletes auth-invalid account without refresh token', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeAuth(root, '2', {
    access_token: makeJwt({
      'https://api.openai.com/profile': { email: 'missing-refresh@example.com' }
    })
  });
  const ctx = makeService(root);

  ctx.service.enqueueAuthInvalidReauthRequired('codex', '2', 'auth_invalid_reauth_required');
  await ctx.runScheduled();

  assert.equal(fs.existsSync(path.join(root, 'profiles', 'codex', '2')), false);
  assert.deepEqual(ctx.deletedStates, [{ provider: 'codex', id: '2' }]);
  assert.deepEqual(ctx.deletedEvents, [
    { provider: 'codex', accountId: '2', reason: 'auth_invalid_missing_refresh_token' }
  ]);
});

test('codex auth invalid reconciler removes state when profile directory is already missing', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ctx = makeService(root);

  ctx.service.enqueueDirectHttpStatus401('codex', '20', 'direct_http_status_401');
  await ctx.runScheduled();

  assert.deepEqual(ctx.deletedStates, [{ provider: 'codex', id: '20' }]);
  assert.deepEqual(ctx.deletedEvents, [
    { provider: 'codex', accountId: '20', reason: 'direct_http_status_401' }
  ]);
});

test('codex auth invalid reconciler clears runtime when refresh succeeds', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeAuth(root, '3', {
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

  ctx.service.enqueueAuthInvalidReauthRequired('codex', '3', 'auth_invalid_reauth_required');
  await ctx.runScheduled();

  assert.equal(fs.existsSync(path.join(root, 'profiles', 'codex', '3')), true);
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].account.refreshToken, 'rt_ok');
  assert.equal(refreshCalls[0].options.force, true);
  assert.deepEqual(ctx.deletedStates, []);
  assert.deepEqual(ctx.deletedEvents, []);
  assert.equal(ctx.clearedRuntime.length, 1);
  assert.equal(ctx.clearedRuntime[0].options.evidence, 'token_refresh_success');
});

test('codex auth invalid reconciler deletes normalized direct usage 401 without refreshing', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeAuth(root, '30', {
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
    '30',
    'auth_invalid_reauth_required:direct_http_status_401'
  );
  await ctx.runScheduled();

  assert.equal(fs.existsSync(path.join(root, 'profiles', 'codex', '30')), false);
  assert.equal(refreshCalls.length, 0);
  assert.deepEqual(ctx.deletedStates, [{ provider: 'codex', id: '30' }]);
  assert.deepEqual(ctx.deletedEvents, [
    { provider: 'codex', accountId: '30', reason: 'auth_invalid_reauth_required:direct_http_status_401' }
  ]);
  assert.equal(ctx.clearedRuntime.length, 0);
});

test('codex auth invalid reconciler deletes when refresh reports terminated session', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeAuth(root, '4', {
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

  ctx.service.enqueueAuthInvalidReauthRequired('codex', '4', 'auth_invalid_reauth_required');
  await ctx.runScheduled();

  assert.equal(fs.existsSync(path.join(root, 'profiles', 'codex', '4')), false);
  assert.deepEqual(ctx.deletedStates, [{ provider: 'codex', id: '4' }]);
  assert.deepEqual(ctx.deletedEvents, [
    { provider: 'codex', accountId: '4', reason: 'refresh_http_400' }
  ]);
});

test('codex auth invalid reconciler keeps account when refresh failure is not session invalid', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeAuth(root, '5', {
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

  ctx.service.enqueueAuthInvalidReauthRequired('codex', '5', 'auth_invalid_reauth_required');
  await ctx.runScheduled();

  assert.equal(fs.existsSync(path.join(root, 'profiles', 'codex', '5')), true);
  assert.deepEqual(ctx.deletedStates, []);
  assert.deepEqual(ctx.deletedEvents, []);
  assert.deepEqual(ctx.clearedRuntime, []);
});

test('codex auth invalid reconciler deduplicates pending account work', async (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeAuth(root, '6', {
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

  assert.equal(ctx.service.enqueueAuthInvalidReauthRequired('codex', '6', 'auth_invalid_reauth_required'), true);
  assert.equal(ctx.service.enqueueAuthInvalidReauthRequired('codex', '6', 'auth_invalid_reauth_required'), false);
  await ctx.runScheduled();

  assert.equal(refreshCount, 1);
  assert.equal(ctx.clearedRuntime.length, 1);
});
