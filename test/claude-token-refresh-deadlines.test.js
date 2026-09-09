'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { readClaudeOauthCredential } = require('../lib/account/claude-credential');
const { readAccountNativeAuth, writeAccountNativeAuth } = require('../lib/server/account-credential-store');
const { loadClaudeServerAccounts } = require('../lib/server/accounts');
const { refreshClaudeAccessToken, __private } = require('../lib/server/claude-token-refresh');
const { createTokenRefreshDaemon } = require('../lib/server/token-refresh-daemon');

const MINUTE = 60_000;
const START = Date.parse('2026-09-08T21:20:00+08:00');

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-refresh-deadlines-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return {
    aiHomeDir,
    register(id, expiresAt, refreshTokenExpiresAt) {
      const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
        provider: 'claude', cliAccountId: id, identitySeed: `test:claude:refresh-deadline:${id}`
      });
      writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
        credentials: { claudeAiOauth: {
          accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt, refreshTokenExpiresAt
        } }
      });
      return accountRef;
    },
    load() {
      return loadClaudeServerAccounts({
        fs, aiHomeDir, checkStatus: () => ({ configured: true, accountName: 'test@example.com' })
      });
    },
    read(accountRef) {
      return readAccountNativeAuth(fs, aiHomeDir, accountRef).credentials.claudeAiOauth;
    }
  };
}

test('Claude refresh uses the earlier credential deadline and ignores unknown deadlines', () => {
  for (const [account, expected] of [
    [{ tokenExpiresAt: START + 180 * MINUTE, refreshTokenExpiresAt: START + 20 * MINUTE }, true],
    [{ tokenExpiresAt: START + 20 * MINUTE, refreshTokenExpiresAt: START + 180 * MINUTE }, true],
    [{ tokenExpiresAt: null, refreshTokenExpiresAt: START + 20 * MINUTE }, true],
    [{ tokenExpiresAt: START + 180 * MINUTE, refreshTokenExpiresAt: START - MINUTE }, true],
    [{ tokenExpiresAt: START + 180 * MINUTE, refreshTokenExpiresAt: 0 }, false],
    [{ tokenExpiresAt: START + 180 * MINUTE, refreshTokenExpiresAt: 'invalid' }, false],
    [{ tokenExpiresAt: null, refreshTokenExpiresAt: null }, false]
  ]) {
    assert.equal(__private.shouldRefreshToken(account, START, 30 * MINUTE), expected);
  }
});

test('Claude credential reader normalizes the optional refresh deadline', () => {
  for (const value of [START, START / 1000, new Date(START).toISOString()]) {
    for (const field of ['refreshTokenExpiresAt', 'refresh_token_expires_at']) {
      const credential = readClaudeOauthCredential({ credentials: { claudeAiOauth: { [field]: value } } });
      assert.equal(credential.refreshTokenExpiresAt, START);
    }
  }
  assert.equal(readClaudeOauthCredential().refreshTokenExpiresAt, 0);
});

test('Claude refresh persists the server refresh lifetime, preserving it only when omitted', async (t) => {
  const fixture = createFixture(t);
  for (const [index, lifetime] of [86400, 0, undefined].entries()) {
    const previousDeadline = START + 44 * MINUTE;
    const accountRef = fixture.register(String(index + 1), START + 180 * MINUTE, previousDeadline);
    const account = fixture.load().find((item) => item.accountRef === accountRef);
    const result = await refreshClaudeAccessToken(account, { force: true, nowMs: START }, {
      fs, aiHomeDir: fixture.aiHomeDir,
      fetchWithTimeout: async () => ({ ok: true, text: async () => JSON.stringify({
        access_token: 'renewed-access', refresh_token: 'renewed-refresh', expires_in: 28800,
        refresh_token_expires_in: lifetime
      }) })
    });
    const expectedDeadline = lifetime === undefined ? previousDeadline : START + lifetime * 1000;
    assert.equal(result.persisted, true);
    assert.equal(fixture.read(accountRef).refreshTokenExpiresAt, expectedDeadline);
    assert.equal(account.refreshTokenExpiresAt, expectedDeadline);
    assert.equal(fixture.load().find((item) => item.accountRef === accountRef).refreshTokenExpiresAt, expectedDeadline);
  }
});

test('daemon renews before the earlier Claude deadline, retries transient failure, and reloads the new deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const fixture = createFixture(t);
  const accountRef = fixture.register('9', Date.parse('2026-09-09T00:20:03.082+08:00'),
    Date.parse('2026-09-08T22:04:28.102+08:00'));
  const otherRef = fixture.register('10', START + 180 * MINUTE, START + 240 * MINUTE);
  const otherBefore = fixture.read(otherRef);
  const state = { accounts: { claude: [] } };
  const calls = [];
  let startupDone;
  const startup = new Promise((resolve) => { startupDone = resolve; });
  const daemon = createTokenRefreshDaemon(state, {}, {
    fs, aiHomeDir: fixture.aiHomeDir,
    reloadRuntimePool: () => { state.accounts.claude = fixture.load(); },
    logInfo: (message) => { if (message.includes('tick #1 completed')) startupDone(); },
    fetchWithTimeout: async (_url, options) => {
      calls.push({ at: Date.now(), token: JSON.parse(options.body).refresh_token });
      if (calls.length === 1) return { ok: false, status: 503, text: async () => '{}' };
      return { ok: true, text: async () => JSON.stringify({
        access_token: 'renewed-access-9', refresh_token: 'renewed-refresh-9', expires_in: 28800,
        refresh_token_expires_in: 86400
      }) };
    }
  });
  t.after(() => daemon.stop());
  await startup;
  assert.equal(calls.length, 0);

  t.mock.timers.setTime(START + 20 * MINUTE);
  await daemon.forceRefresh();
  assert.equal(calls.length, 1, 'first attempt must be before 22:04, while access remains valid for hours');
  assert.equal(calls[0].token, 'refresh-9');
  t.mock.timers.setTime(START + 30 * MINUTE);
  await daemon.forceRefresh();
  assert.equal(calls.length, 2, 'transient failure must leave time for the next scheduled attempt');
  assert.equal(fixture.read(accountRef).refreshToken, 'renewed-refresh-9');

  t.mock.timers.setTime(START + 40 * MINUTE);
  await daemon.forceRefresh();
  assert.equal(calls.length, 2, 'new refresh lifetime must prevent repeated premature refreshes');
  assert.deepEqual(fixture.read(otherRef), otherBefore, 'another account must remain unchanged');
});

test('daemon startup keeps a proactive window with time for another poll after failure', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  const fixture = createFixture(t);
  fixture.register('1', START + 8 * MINUTE, START + 240 * MINUTE);
  for (const options of [{}, { tokenRefreshIntervalMs: 20 * MINUTE, tokenRefreshBeforeExpiryMs: MINUTE,
    tokenStartupRefreshBeforeExpiryMs: MINUTE }]) {
    let startupDone;
    const startup = new Promise((resolve) => { startupDone = resolve; });
    let calls = 0;
    const daemon = createTokenRefreshDaemon({ accounts: { claude: fixture.load() } }, options, {
      fs, aiHomeDir: fixture.aiHomeDir,
      logInfo: (message) => { if (message.includes('tick #1 completed')) startupDone(); },
      fetchWithTimeout: async () => { calls += 1; return { ok: false, status: 503, text: async () => '{}' }; }
    });
    try {
      await startup;
      assert.equal(calls, 1, 'startup must not wait for the first periodic tick past expiry');
      assert.ok(daemon.getStats().skewMs >= 2 * daemon.getStats().refreshIntervalMs);
    } finally {
      daemon.stop();
    }
  }
});
