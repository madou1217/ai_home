'use strict';

// Cline Pass 的续期契约（2026-10-14 实测）：
//   POST {base}/auth/refresh {refreshToken, grantType:'refresh_token'}
//   → 200 {success:true, data:{accessToken:'<裸 JWT>', refreshToken, expiresAt:'<ISO>'}}
// 三条必须守住的行为：落盘前给 accessToken 补 `workos:` 前缀（裸 JWT 出网 401）、
// cline 与 cline-pass 两个槽位同写（只写一个会让另一个持有已被消费的 grant）、
// 别家 provider 的密钥一个字节都不许动。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { refreshClineAccessToken } = require('../lib/server/cline-token-refresh');

const REFRESH_URL = 'https://api.cline.bot/api/v1/auth/refresh';
const CLINE_ARTIFACT_PATH = '.cline/data/settings/providers.json';

function clineProvidersDocument({ accessToken, refreshToken, expiresAt, extraProviders = {} }) {
  const auth = { accessToken, refreshToken, expiresAt: String(expiresAt) };
  return {
    version: '1',
    lastUsedProvider: 'cline-pass',
    providers: {
      cline: { settings: { auth }, updatedAt: '2026-10-14T00:00:00.000Z' },
      // Cline Pass 登录会同时写两个槽位；这里保留槽位私有设置以验证写回不覆盖它们。
      'cline-pass': {
        settings: { auth, model: 'cline-pass/glm-5.3', reasoning: 'high' },
        updatedAt: '2026-10-14T00:00:00.000Z'
      },
      ...extraProviders
    }
  };
}

function createClineFixture(t, document) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cline-refresh-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'cline',
    cliAccountId: '1',
    identitySeed: 'oauth:cline:refresh-user-1'
  });
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, { auth: document });
  return { aiHomeDir, accountRef: registration.accountRef };
}

// 出网解析注入成常量：测试只关心刷新策略本身，断言它被调用说明真的走了 egress 边界。
function createDeps(fixture, fetchWithTimeout, capture = {}) {
  const notified = [];
  return {
    notified,
    deps: {
      fs,
      aiHomeDir: fixture.aiHomeDir,
      fetchWithTimeout,
      resolveAccountEgressRequestOptions: async (input) => {
        capture.egressInput = input;
        capture.egressCalls = (capture.egressCalls || 0) + 1;
        return { ok: true, options: { proxyUrl: 'http://127.0.0.1:7890', noProxy: ['api.cline.bot'] } };
      },
      accountArtifactHooks: {
        notifyDefaultAccountAuthUpdated: (payload) => notified.push(payload)
      }
    }
  };
}

function okRefreshResponse(payload, capture) {
  return async (url, options, timeoutMs, proxyOptions) => {
    capture.url = url;
    capture.method = options && options.method;
    capture.headers = options && options.headers;
    capture.body = String((options && options.body) || '');
    capture.timeoutMs = timeoutMs;
    capture.proxyOptions = proxyOptions;
    capture.requests = (capture.requests || 0) + 1;
    return { ok: true, status: 200, headers: {}, json: async () => payload };
  };
}

test('cline refresh rewrites both slots with a prefixed access token and ms expiry', async (t) => {
  const expiredAt = Date.now() - 60_000;
  const fixture = createClineFixture(t, clineProvidersDocument({
    accessToken: 'workos:eyJold.payload.sig',
    refreshToken: 'rt_old',
    expiresAt: expiredAt,
    extraProviders: { anthropic: { settings: { apiKey: 'sk-ant-user-owned' } } }
  }));
  const expiresAtMs = Date.now() + 60 * 60 * 1000;
  const account = {
    provider: 'cline',
    accountRef: fixture.accountRef,
    accessToken: 'workos:eyJold.payload.sig',
    refreshToken: 'rt_old',
    tokenExpiresAt: expiredAt
  };
  const capture = {};
  const { deps, notified } = createDeps(fixture, okRefreshResponse({
    success: true,
    data: {
      accessToken: 'eyJnew.payload.sig',
      tokenType: 'Bearer',
      expiresAt: new Date(expiresAtMs).toISOString(),
      refreshToken: 'rt_new',
      userInfo: { email: 'cline-user@example.com' }
    }
  }, capture), capture);

  const result = await refreshClineAccessToken(account, { force: true }, deps);

  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(result.reason, 'refreshed');
  assert.equal(result.expiresAt, expiresAtMs);
  assert.equal(result.persisted.updated, true);

  assert.equal(capture.url, REFRESH_URL);
  assert.equal(capture.method, 'POST');
  assert.equal(capture.timeoutMs, 20_000);
  assert.equal(capture.headers.accept, 'application/json');
  assert.deepEqual(JSON.parse(capture.body), {
    refreshToken: 'rt_old',
    grantType: 'refresh_token'
  });
  assert.deepEqual(capture.proxyOptions, {
    proxyUrl: 'http://127.0.0.1:7890',
    noProxy: ['api.cline.bot']
  });
  assert.equal(capture.egressInput.provider, 'cline');
  assert.equal(capture.egressInput.accountRef, fixture.accountRef);

  // 内存：ISO 归一成 ms，裸 JWT 补 workos: 前缀。
  assert.equal(account.accessToken, 'workos:eyJnew.payload.sig');
  assert.equal(account.refreshToken, 'rt_new');
  assert.equal(account.tokenExpiresAt, expiresAtMs);

  const stored = readAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef);
  for (const slotId of ['cline', 'cline-pass']) {
    const slotAuth = stored.auth.providers[slotId].settings.auth;
    assert.equal(slotAuth.accessToken, 'workos:eyJnew.payload.sig', slotId);
    assert.equal(slotAuth.refreshToken, 'rt_new', slotId);
    // 必须是毫秒**数字**：字符串会让 CLI 把账号判成未登录（见 test/cline-credential-document.test.js 的实测说明）。
    assert.equal(slotAuth.expiresAt, expiresAtMs, slotId);
    assert.equal(typeof slotAuth.expiresAt, 'number', slotId);
  }
  // 槽位私有设置与别家 provider 的密钥原样保留。
  assert.equal(stored.auth.providers['cline-pass'].settings.model, 'cline-pass/glm-5.3');
  assert.equal(stored.auth.providers['cline-pass'].settings.reasoning, 'high');
  assert.equal(stored.auth.providers.anthropic.settings.apiKey, 'sk-ant-user-owned');

  assert.equal(notified.length, 1);
  assert.equal(notified[0].provider, 'cline');
  assert.equal(notified[0].accountRef, fixture.accountRef);
  assert.equal(notified[0].artifactPath, CLINE_ARTIFACT_PATH);
  assert.equal(notified[0].reason, 'cline_oauth_token_refreshed');
});

test('cline refresh re-syncs a grant the CLI rotated on disk instead of spending it', async (t) => {
  const rotatedExpiry = Date.now() + 55 * 60 * 1000;
  const fixture = createClineFixture(t, clineProvidersDocument({
    accessToken: 'workos:eyJrotated.payload.sig',
    refreshToken: 'rt_rotated',
    expiresAt: rotatedExpiry
  }));
  // 运行池里还是几分钟前的快照：过期在即 + 已被消费的 grant。
  const account = {
    provider: 'cline',
    accountRef: fixture.accountRef,
    accessToken: 'workos:eyJstale.payload.sig',
    refreshToken: 'rt_stale',
    tokenExpiresAt: Date.now() - 60_000
  };
  const capture = {};
  const { deps } = createDeps(fixture, okRefreshResponse({ success: true, data: {} }, capture), capture);

  const result = await refreshClineAccessToken(account, {}, deps);

  assert.equal(result.ok, true);
  assert.equal(result.refreshed, false);
  assert.equal(result.reason, 'not_due');
  assert.equal(capture.requests || 0, 0);
  assert.equal(account.accessToken, 'workos:eyJrotated.payload.sig');
  assert.equal(account.refreshToken, 'rt_rotated');
  assert.equal(account.tokenExpiresAt, rotatedExpiry);
});

test('cline refresh skips a token that is still far from expiry', async (t) => {
  const expiresAtMs = Date.now() + 3 * 60 * 60 * 1000;
  const fixture = createClineFixture(t, clineProvidersDocument({
    accessToken: 'workos:eyJlive.payload.sig',
    refreshToken: 'rt_live',
    expiresAt: expiresAtMs
  }));
  const account = {
    provider: 'cline',
    accountRef: fixture.accountRef,
    accessToken: 'workos:eyJlive.payload.sig',
    refreshToken: 'rt_live',
    tokenExpiresAt: expiresAtMs
  };
  const capture = {};
  const { deps, notified } = createDeps(fixture, okRefreshResponse({ success: true, data: {} }, capture), capture);

  const result = await refreshClineAccessToken(account, {}, deps);

  assert.deepEqual(result, { ok: true, refreshed: false, reason: 'not_due' });
  assert.equal(capture.requests || 0, 0);
  assert.equal(capture.egressCalls || 0, 0);
  assert.equal(notified.length, 0);
});

test('cline refresh throttles a second attempt inside the minimum interval', async (t) => {
  const fixture = createClineFixture(t, clineProvidersDocument({
    accessToken: 'workos:eyJold.payload.sig',
    refreshToken: 'rt_old',
    expiresAt: Date.now() - 60_000
  }));
  const nowMs = Date.now();
  const account = {
    provider: 'cline',
    accountRef: fixture.accountRef,
    accessToken: 'workos:eyJold.payload.sig',
    refreshToken: 'rt_old',
    tokenExpiresAt: nowMs - 60_000,
    _lastRefreshAttemptAt: nowMs
  };
  const capture = {};
  const { deps } = createDeps(fixture, okRefreshResponse({ success: true, data: {} }, capture), capture);

  const result = await refreshClineAccessToken(account, { nowMs }, deps);

  assert.equal(result.reason, 'throttled');
  assert.equal(capture.requests || 0, 0);
});

test('cline refresh keeps the previous refresh token when the response omits one', async (t) => {
  const fixture = createClineFixture(t, clineProvidersDocument({
    accessToken: 'workos:eyJold.payload.sig',
    refreshToken: 'rt_old',
    expiresAt: Date.now() - 60_000
  }));
  const expiresAtMs = Date.now() + 45 * 60 * 1000;
  const account = {
    provider: 'cline',
    accountRef: fixture.accountRef,
    accessToken: 'workos:eyJold.payload.sig',
    refreshToken: 'rt_old',
    tokenExpiresAt: Date.now() - 60_000
  };
  const capture = {};
  const { deps } = createDeps(fixture, okRefreshResponse({
    success: true,
    data: { accessToken: 'eyJnew.payload.sig', expiresAt: new Date(expiresAtMs).toISOString() }
  }, capture), capture);

  const result = await refreshClineAccessToken(account, { force: true }, deps);

  assert.equal(result.reason, 'refreshed');
  assert.equal(account.refreshToken, 'rt_old');
  const stored = readAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef);
  assert.equal(stored.auth.providers.cline.settings.auth.refreshToken, 'rt_old');
  assert.equal(stored.auth.providers['cline-pass'].settings.auth.refreshToken, 'rt_old');
});

test('cline refresh reports an invalid grant without echoing any token back', async (t) => {
  const fixture = createClineFixture(t, clineProvidersDocument({
    accessToken: 'workos:eyJold.payload.sig',
    refreshToken: 'rt_old',
    expiresAt: Date.now() - 60_000
  }));
  const account = {
    provider: 'cline',
    accountRef: fixture.accountRef,
    accessToken: 'workos:eyJold.payload.sig',
    refreshToken: 'rt_old',
    tokenExpiresAt: Date.now() - 60_000
  };
  const { deps } = createDeps(fixture, async () => ({
    ok: false,
    status: 401,
    headers: {},
    arrayBuffer: async () => Buffer.from(JSON.stringify({
      error: 'Unauthorized: invalid refresh token rt_old for workos:eyJold.payload.sig'
    }), 'utf8')
  }));

  const result = await refreshClineAccessToken(account, { force: true }, deps);

  assert.equal(result.ok, false);
  assert.equal(result.refreshed, false);
  assert.equal(result.reason, 'refresh_http_401');
  assert.equal(result.status, 401);
  assert.equal(result.oauthError, 'invalid_refresh_token');
  assert.match(result.detail, /invalid refresh token/i);
  assert.match(result.detail, /\[redacted\]/);
  assert.equal(result.detail.includes('rt_old'), false);
  assert.equal(result.detail.includes('eyJold'), false);
  // 失败不写盘：磁盘仍是原 grant，内存里的 accessToken 也没被换成半成品。
  const stored = readAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef);
  assert.equal(stored.auth.providers.cline.settings.auth.refreshToken, 'rt_old');
  assert.equal(account.accessToken, 'workos:eyJold.payload.sig');
});

test('cline refresh refuses non-cline, api-key, and context-less accounts', async (t) => {
  const fixture = createClineFixture(t, clineProvidersDocument({
    accessToken: 'workos:eyJlive.payload.sig',
    refreshToken: 'rt_live',
    expiresAt: Date.now() - 60_000
  }));
  const capture = {};
  const { deps } = createDeps(fixture, okRefreshResponse({ success: true, data: {} }, capture), capture);

  assert.equal((await refreshClineAccessToken(null, {}, deps)).reason, 'invalid_account');
  assert.equal(
    (await refreshClineAccessToken({ provider: 'kimi', accountRef: fixture.accountRef }, {}, deps)).reason,
    'not_cline'
  );
  assert.equal((await refreshClineAccessToken({
    provider: 'cline',
    accountRef: fixture.accountRef,
    authType: 'api-key',
    apiKey: 'sk_cline_api_key'
  }, {}, deps)).reason, 'not_oauth');
  assert.equal((await refreshClineAccessToken({
    provider: 'cline',
    accountRef: fixture.accountRef
  }, {}, { ...deps, aiHomeDir: '' })).reason, 'missing_account_ref');
  assert.equal(capture.requests || 0, 0);
  assert.equal(capture.egressCalls || 0, 0);
});

test('cline refresh refuses an oauth account whose document holds no refresh token', async (t) => {
  const fixture = createClineFixture(t, {
    version: '1',
    lastUsedProvider: 'cline',
    providers: {
      cline: { settings: { apiKey: 'sk_cline_from_cli' }, updatedAt: '2026-10-14T00:00:00.000Z' }
    }
  });
  const capture = {};
  const { deps } = createDeps(fixture, okRefreshResponse({ success: true, data: {} }, capture), capture);

  const result = await refreshClineAccessToken({
    provider: 'cline',
    accountRef: fixture.accountRef,
    tokenExpiresAt: Date.now() - 60_000
  }, {}, deps);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_refresh_token');
  assert.equal(capture.requests || 0, 0);
});
