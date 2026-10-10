'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { createAccountStateService } = require('../lib/account/state-service');
const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { writeAccountUsageSnapshot, readAccountUsageSnapshot } = require('../lib/account/usage-snapshot-store');
const { createUsageCacheService } = require('../lib/cli/services/usage/cache');
const { createUsageSnapshotService } = require('../lib/cli/services/usage/snapshot');
const { loadServerRuntimeAccounts } = require('../lib/server/accounts');
const { applyReloadState } = require('../lib/server/management');
const { chooseServerAccount } = require('../lib/server/router');
const { handleWebUiCodexResetCreditRoutes } = require('../lib/server/webui-codex-reset-credit-routes');
const { __private } = require('../lib/server/webui-account-live');

const MODEL = 'gpt-6.1-sol';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

for (const retainedFailure of ['', 'billing_blocked', 'network_error']) {
  test(`confirmed reset refreshes persisted quota, scheduling and watchers while retaining ${retainedFailure || 'no unrelated failure'}`, async (t) => {
    const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-reset-runtime-'));
    const accountStateIndex = createAccountStateIndex({ fs, aiHomeDir });
    const accountStateService = createAccountStateService({ accountStateIndex });
    const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
      provider: 'codex', cliAccountId: '71', identitySeed: 'test:codex:reset-runtime'
    });
    writeAccountNativeAuth(fs, aiHomeDir, accountRef, { auth: {
      tokens: { access_token: 'local-fixture-token', refresh_token: 'local-fixture-refresh', account_id: 'fixture' }
    } });

    const now = Date.now();
    const usageSnapshot = {
      schemaVersion: 2, kind: 'codex_oauth_status', source: 'codex_app_server', capturedAt: now - 2000,
      account: { planType: 'plus', email: 'reset@example.test' },
      entries: [{ bucket: 'primary', windowMinutes: 300, remainingPct: 0 }]
    };
    writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, usageSnapshot);
    accountStateIndex.upsertRuntimeState(accountRef, 'codex', {
      lastFailureAt: now - 1000, lastFailureKind: 'rate_limited', lastFailureReason: 'usage_limit_reached',
      cooldownUntil: now + 86400000, rateLimitUntil: now + 86400000,
      networkUntil: retainedFailure === 'network_error' ? now + 60000 : 0,
      routingBlock: { kind: retainedFailure === 'billing_blocked' ? 'billing_blocked' : 'quota_exhausted', observedAt: now - 1000 },
      modelCooldowns: { [MODEL]: now + 86400000 },
      modelFailureStreaks: { [MODEL]: { kind: 'rate_limited', reason: 'usage_limit_reached', observedAt: now - 1000, count: 1, expiresAt: now + 86400000 } }
    }, { configured: true, apiKeyMode: false });

    let usageRequests = 0;
    const upstream = http.createServer((req, res) => {
      assert.equal(req.url, '/wham/usage');
      assert.equal(req.headers.authorization, 'Bearer local-fixture-token');
      usageRequests++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ rate_limits: { primary: { window_minutes: 300, used_percent: 0, resets_at: Math.floor(now / 1000) + 3600 } } }));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
      accountStateIndex.close();
      fs.rmSync(aiHomeDir, { recursive: true, force: true });
    });
    const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
    const getProfileDir = (provider, ref) => path.join(aiHomeDir, 'profiles', provider, ref);
    const getToolConfigDir = (provider, ref) => path.join(getProfileDir(provider, ref), `.${provider}`);
    const cache = createUsageCacheService({ fs, aiHomeDir, usageSnapshotSchemaVersion: 2, usageSourceCodex: 'codex_app_server' });
    const usage = createUsageSnapshotService({
      fs, path, aiHomeDir, accountStateService, getProfileDir, getToolConfigDir,
      usageSnapshotSchemaVersion: 2, usageSourceCodex: 'codex_app_server', usageRefreshStaleMs: 300000,
      processObj: { execPath: process.execPath, cwd: () => aiHomeDir, platform: process.platform,
        env: { AIH_CODEX_USAGE_BASE_URL: baseUrl, AIH_CODEX_USAGE_PATH: '/wham/usage' } },
      resolveCliPath: () => '',
      spawn: () => { throw new Error('local HTTP quota probe must not spawn a CLI'); },
      fetchImpl: (url, init) => {
        assert.ok(url.startsWith(`${baseUrl}/`), 'the test must never contact a production upstream');
        return fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
      },
      writeUsageCache: cache.writeUsageCache, readUsageCache: cache.readUsageCache
    });
    const context = {
      fs, aiHomeDir, accountStateIndex, accountStateService, getProfileDir, getToolConfigDir,
      checkStatus: () => ({ configured: true }), options: {},
      loadServerRuntimeAccounts, applyReloadState, ...usage
    };
    context.state = { accounts: loadServerRuntimeAccounts(context), sessionAffinity: { codex: new Map([['old-session', accountRef]]) } };
    assert.equal(chooseServerAccount(context.state.accounts.codex, {}, 'codex', { model: MODEL }), null);
    const events = [];
    __private.getAccountsLiveState(context.state).watchers.add({ res: {
      write(frame) { events.push(JSON.parse(frame.slice('data: '.length))); }
    } });
    let response;
    Object.assign(context, {
      method: 'POST', pathname: `/v0/webui/accounts/codex/${accountRef}/reset-credits/consume`,
      req: {}, res: { setHeader() {} },
      readRequestBody: async () => Buffer.from(JSON.stringify({ operationId: OPERATION_ID, inventoryVersion: 'fixture' })),
      writeJson: (_res, status, body) => { response = { status, body }; },
      deps: { codexResetCreditService: { consume: async () => ({ operation: { status: 'succeeded', outcome: 'reset' }, reconciliationRequired: false }) } }
    });
    await handleWebUiCodexResetCreditRoutes(context);

    assert.equal(response.status, 200);
    assert.equal(usageRequests, 1);
    assert.equal(readAccountUsageSnapshot(fs, aiHomeDir, accountRef).entries[0].remainingPct, 100);
    const persisted = accountStateIndex.getAccountState(accountRef).runtimeState;
    assert.equal(persisted.modelCooldowns[MODEL], undefined);
    assert.equal(persisted.routingBlock?.kind || '', retainedFailure === 'billing_blocked' ? 'billing_blocked' : '');
    assert.equal(persisted.networkUntil, retainedFailure === 'network_error' ? now + 60000 : 0);
    const selected = chooseServerAccount(context.state.accounts.codex, {}, 'codex', { model: MODEL });
    assert.equal(selected?.accountRef || null, retainedFailure ? null : accountRef);
    assert.equal(context.state.sessionAffinity.codex.size, 0);
    const accountEvent = events.find(event => event.type === 'account' && event.account.accountRef === accountRef);
    assert.ok(accountEvent, 'watch subscribers receive the refreshed account');
    // 可信快照已恢复到 100%；若仍有账单/网络阻塞，公开的 remainingPct 会按
    // 运行态保护为 null，避免把不可调度账号显示成可用。
    assert.equal(accountEvent.account.usageSnapshot.entries[0].remainingPct, 100);
    assert.equal(accountEvent.account.remainingPct, retainedFailure ? null : 100);
    assert.equal(accountEvent.account.schedulableStatus, retainedFailure ? 'blocked_by_runtime_status' : 'schedulable');
  });
}
