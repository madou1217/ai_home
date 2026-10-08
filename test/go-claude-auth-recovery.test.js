'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createGoClaudeAuthRecovery } = require('../lib/server/go-claude-auth-recovery');

const ACCOUNT_REF = 'acct_1234567890abcdef1234';

function setup(options = {}) {
  let now = 1_000_000;
  let accessToken = 'old-access-token';
  let refreshCalls = 0;
  let updateCalls = 0;
  const recovery = createGoClaudeAuthRecovery({
    aiHomeDir: '/tmp/aih-test',
    now: () => now,
    readAccountNativeAuth: (_fs, _aiHomeDir, accountRef) => accountRef === ACCOUNT_REF
      ? { credentials: { claudeAiOauth: { accessToken, refreshToken: 'refresh-token', expiresAt: now + 3_600_000 } } }
      : {},
    refreshClaudeAccessToken: async () => {
      refreshCalls += 1;
      if (options.refreshResult) return options.refreshResult;
      if (options.rotateToken !== false) accessToken = `new-access-token-${refreshCalls}`;
      return { ok: true, refreshed: true };
    },
    onCredentialUpdated: async () => {
      updateCalls += 1;
      return options.updateResult !== false;
    },
    retryAfterMs: 60_000
  });
  return {
    recovery,
    calls: () => ({ refreshCalls, updateCalls }),
    advance(ms) { now += ms; }
  };
}

test('Claude OAuth 403 refreshes once and reuses the new token for the retry', async () => {
  const fixture = setup({ rotateToken: false });
  const input = { entryId: 'gateway.anthropic.messages', statusCode: 403, accountRef: ACCOUNT_REF };

  assert.equal(await fixture.recovery.recover(input), true);
  assert.deepEqual(fixture.calls(), { refreshCalls: 1, updateCalls: 1 });

  fixture.advance(1_000);
  assert.equal(await fixture.recovery.recover(input), false, 'the same access token failure is rate limited');
  assert.deepEqual(fixture.calls(), { refreshCalls: 1, updateCalls: 1 });
});

test('Claude OAuth 401 also enters the bounded recovery path', async () => {
  const fixture = setup();
  assert.equal(await fixture.recovery.recover({
    entryId: 'gateway.anthropic.messages',
    statusCode: 401,
    accountRef: ACCOUNT_REF
  }), true);
  assert.deepEqual(fixture.calls(), { refreshCalls: 1, updateCalls: 1 });
});

test('a new access token gets its own recovery attempt', async () => {
  const fixture = setup();
  const input = { entryId: 'gateway.anthropic.messages', statusCode: 403, accountRef: ACCOUNT_REF };

  assert.equal(await fixture.recovery.recover(input), true);
  fixture.advance(60_001);
  assert.equal(await fixture.recovery.recover(input), true);
  assert.deepEqual(fixture.calls(), { refreshCalls: 2, updateCalls: 2 });
});

test('a rotated token remains inside the account cooldown window', async () => {
  const fixture = setup();
  const input = { entryId: 'gateway.anthropic.messages', statusCode: 403, accountRef: ACCOUNT_REF };

  assert.equal(await fixture.recovery.recover(input), true);
  fixture.advance(1_000);
  assert.equal(await fixture.recovery.recover(input), false);
  assert.deepEqual(fixture.calls(), { refreshCalls: 1, updateCalls: 1 });
});

test('concurrent Claude 403s share one in-flight OAuth recovery', async () => {
  let resolveRefresh;
  // The regular fixture's refresh completes immediately, so use a dedicated recovery with a held promise.
  let refreshCalls = 0;
  let updateCalls = 0;
  const recovery = createGoClaudeAuthRecovery({
    aiHomeDir: '/tmp/aih-test',
    now: () => 1_000_000,
    readAccountNativeAuth: () => ({ credentials: { claudeAiOauth: {
      accessToken: 'held-access-token',
      refreshToken: 'refresh-token',
      expiresAt: 4_600_000
    } } }),
    refreshClaudeAccessToken: () => {
      refreshCalls += 1;
      return new Promise((resolve) => { resolveRefresh = resolve; });
    },
    onCredentialUpdated: async () => {
      updateCalls += 1;
      return true;
    },
    retryAfterMs: 60_000
  });
  const input = { entryId: 'gateway.anthropic.messages', statusCode: 403, accountRef: ACCOUNT_REF };
  const first = recovery.recover(input);
  const second = recovery.recover(input);
  assert.equal(refreshCalls, 1);
  resolveRefresh({ ok: true, refreshed: true });
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(updateCalls, 1);
});

test('non-Claude routes, non-auth responses, and accounts without OAuth never refresh', async () => {
  const fixture = setup();
  assert.equal(await fixture.recovery.recover({ entryId: 'gateway.openai.responses', statusCode: 403, accountRef: ACCOUNT_REF }), false);
  assert.equal(await fixture.recovery.recover({ entryId: 'gateway.anthropic.messages', statusCode: 400, accountRef: ACCOUNT_REF }), false);
  assert.equal(await fixture.recovery.recover({ entryId: 'gateway.anthropic.messages', statusCode: 403, accountRef: 'acct_ffffffffffffffffffff' }), false);
  assert.deepEqual(fixture.calls(), { refreshCalls: 0, updateCalls: 0 });
});

test('refresh failure leaves the original request on the caller path', async () => {
  const fixture = setup({ refreshResult: { ok: false, refreshed: false, reason: 'refresh_http_401' } });
  assert.equal(await fixture.recovery.recover({ entryId: 'gateway.anthropic.messages', statusCode: 403, accountRef: ACCOUNT_REF }), false);
  assert.deepEqual(fixture.calls(), { refreshCalls: 1, updateCalls: 0 });
});

test('a refresh that cannot persist credentials does not replay the request', async () => {
  const fixture = setup({ refreshResult: { ok: true, refreshed: true, persisted: false } });
  assert.equal(await fixture.recovery.recover({ entryId: 'gateway.anthropic.messages', statusCode: 403, accountRef: ACCOUNT_REF }), false);
  assert.deepEqual(fixture.calls(), { refreshCalls: 1, updateCalls: 0 });
});
