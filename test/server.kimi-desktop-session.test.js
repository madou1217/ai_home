'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createDesktopLoginQRCode,
  getDesktopLoginQRCodeStatus,
  refreshDesktopSessionToken,
  readDesktopSession,
  writeDesktopSession,
  ensureDesktopSessionAccessToken,
  QR_STATUS
} = require('../lib/server/kimi-desktop-session');
const { upsertAccountRef } = require('../lib/server/account-ref-store');

function makeJwt(expSeconds) {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `h.${payload}.s`;
}

function createStoreFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-desktop-session-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'kimi',
    cliAccountId: '2',
    identitySeed: 'oauth:kimi:acct@example.com'
  });
  return { aiHomeDir, accountRef };
}

// createFetchMock 按调用队列返回响应，并记录每次调用的 url/method/payload。
function createFetchMock(responses) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options, payload: JSON.parse(String(options.body || '{}')) });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return {
      status: next.status,
      json: async () => next.data
    };
  };
  return { calls, fetchImpl };
}

test('createDesktopLoginQRCode 返回 code 与微信扫码 URL', async () => {
  const { calls, fetchImpl } = createFetchMock([{ status: 200, data: { code: 'qr-123' } }]);
  const result = await createDesktopLoginQRCode({ fetchImpl, authBaseUrl: 'https://auth.test/api' });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'qr-123');
  assert.equal(result.qrUrl, 'https://www.kimi.com/wechat/mp/auth?id=qr-123');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/account\.gateway\.v1\.AuthService\/CreateLoginQRCode$/);
  assert.equal(calls[0].options.method, 'POST');
});

test('createDesktopLoginQRCode 在非 200 或缺 code 时返回失败', async () => {
  const httpFail = await createDesktopLoginQRCode({
    fetchImpl: createFetchMock([{ status: 500, data: {} }]).fetchImpl,
    authBaseUrl: 'https://auth.test/api'
  });
  assert.equal(httpFail.ok, false);
  assert.equal(httpFail.error, 'create_qrcode_http_500');

  const noCode = await createDesktopLoginQRCode({
    fetchImpl: createFetchMock([{ status: 200, data: {} }]).fetchImpl,
    authBaseUrl: 'https://auth.test/api'
  });
  assert.equal(noCode.ok, false);
});

test('getDesktopLoginQRCodeStatus 透传 pending/scanned 状态', async () => {
  const { fetchImpl } = createFetchMock([{ status: 200, data: { status: 'STATUS_SCANNED' } }]);
  const result = await getDesktopLoginQRCodeStatus({ fetchImpl, authBaseUrl: 'https://auth.test/api' }, 'qr-1');
  assert.equal(result.ok, true);
  assert.equal(result.status, QR_STATUS.SCANNED);
});

test('getDesktopLoginQRCodeStatus 在缺 code 时不发起请求', async () => {
  const { calls, fetchImpl } = createFetchMock([{ status: 200, data: {} }]);
  const result = await getDesktopLoginQRCodeStatus({ fetchImpl }, '  ');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'missing_code');
  assert.equal(calls.length, 0);
});

test('getDesktopLoginQRCodeStatus 解析官方 camelCase SUCCESS token，缺 token 视为失败', async () => {
  const ok = await getDesktopLoginQRCodeStatus({
    fetchImpl: createFetchMock([{
      status: 200,
      data: {
        status: 'STATUS_SUCCESS',
        accessToken: 'web-access',
        refreshToken: 'web-refresh',
        userId: 'u-1'
      }
    }]).fetchImpl,
    authBaseUrl: 'https://auth.test/api'
  }, 'qr-1');
  assert.equal(ok.ok, true);
  assert.equal(ok.accessToken, 'web-access');
  assert.equal(ok.refreshToken, 'web-refresh');
  assert.equal(ok.userId, 'u-1');

  const missing = await getDesktopLoginQRCodeStatus({
    fetchImpl: createFetchMock([{ status: 200, data: { status: 'STATUS_SUCCESS' } }]).fetchImpl,
    authBaseUrl: 'https://auth.test/api'
  }, 'qr-1');
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'qrcode_success_without_tokens');
});

test('getDesktopLoginQRCodeStatus 兼容 snake_case SUCCESS token', async () => {
  const result = await getDesktopLoginQRCodeStatus({
    fetchImpl: createFetchMock([{
      status: 200,
      data: {
        status: 'STATUS_SUCCESS',
        access_token: 'legacy-access',
        refresh_token: 'legacy-refresh',
        user_id: 'legacy-user'
      }
    }]).fetchImpl,
    authBaseUrl: 'https://auth.test/api'
  }, 'qr-1');
  assert.equal(result.ok, true);
  assert.equal(result.accessToken, 'legacy-access');
  assert.equal(result.refreshToken, 'legacy-refresh');
  assert.equal(result.userId, 'legacy-user');
});

test('refreshDesktopSessionToken 解析官方 camelCase 轮换 token，401 归为未授权', async () => {
  const { calls, fetchImpl } = createFetchMock([{
    status: 200,
    data: { accessToken: 'new-access', refreshToken: 'new-refresh' }
  }]);
  const ok = await refreshDesktopSessionToken({ fetchImpl, authBaseUrl: 'https://auth.test/api' }, 'old-refresh');
  assert.equal(ok.ok, true);
  assert.equal(ok.accessToken, 'new-access');
  assert.equal(ok.refreshToken, 'new-refresh');
  assert.equal(calls[0].payload.refresh_token, 'old-refresh');

  const unauthorized = await refreshDesktopSessionToken({
    fetchImpl: createFetchMock([{ status: 401, data: {} }]).fetchImpl,
    authBaseUrl: 'https://auth.test/api'
  }, 'old-refresh');
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.error, 'desktop_session_refresh_unauthorized');
});

test('Kimi Desktop 扫码与 session 刷新统一使用账号绑定出口', async () => {
  const responses = [
    { status: 200, data: { code: 'qr-egress' } },
    { status: 200, data: { status: 'STATUS_PENDING' } },
    { status: 200, data: { accessToken: 'new-access', refreshToken: 'new-refresh' } }
  ];
  const directCalls = [];
  const resolvedInputs = [];
  const proxyOptions = [];
  const deps = {
    fs,
    aiHomeDir: '/tmp/aih-kimi-desktop-egress',
    accountRef: 'acct_01000000000000000031',
    authBaseUrl: 'https://auth.test/api',
    proxyUrl: 'http://global-proxy.example:7890',
    noProxy: 'global.example',
    async resolveAccountEgressRequestOptions(input) {
      resolvedInputs.push(input);
      return {
        ok: true,
        bound: true,
        options: {
          ...input.options,
          proxyUrl: 'http://127.0.0.1:23131',
          noProxy: 'localhost,127.0.0.1,::1'
        }
      };
    },
    async fetchImpl(url, options) {
      directCalls.push({ url, options });
      const next = responses.shift();
      return { status: next.status, json: async () => next.data };
    },
    async fetchWithTimeout(url, options, _timeoutMs, requestOptions) {
      proxyOptions.push(requestOptions);
      const next = responses.shift();
      return { status: next.status, json: async () => next.data };
    }
  };

  const created = await createDesktopLoginQRCode(deps);
  const polled = await getDesktopLoginQRCodeStatus(deps, created.code);
  const refreshed = await refreshDesktopSessionToken(deps, 'old-refresh');

  assert.equal(created.ok, true);
  assert.equal(polled.status, QR_STATUS.PENDING);
  assert.equal(refreshed.ok, true);
  assert.equal(directCalls.length, 0);
  assert.equal(resolvedInputs.length, 3);
  assert.deepEqual(resolvedInputs.map((input) => [input.provider, input.accountRef]), [
    ['kimi', deps.accountRef],
    ['kimi', deps.accountRef],
    ['kimi', deps.accountRef]
  ]);
  assert.deepEqual(proxyOptions, [
    { proxyUrl: 'http://127.0.0.1:23131', noProxy: 'localhost,127.0.0.1,::1' },
    { proxyUrl: 'http://127.0.0.1:23131', noProxy: 'localhost,127.0.0.1,::1' },
    { proxyUrl: 'http://127.0.0.1:23131', noProxy: 'localhost,127.0.0.1,::1' }
  ]);
});

test('desktopSession 写入后可读回且与既有 nativeAuth 字段并存', (t) => {
  const { aiHomeDir, accountRef } = createStoreFixture(t);
  const { writeAccountNativeAuth } = require('../lib/server/account-credential-store');
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, { oauthCreds: { access_token: 'cli-token' } });

  assert.equal(writeDesktopSession(fs, aiHomeDir, accountRef, {
    accessToken: 'web-access',
    refreshToken: 'web-refresh',
    userId: 'u-9'
  }), true);

  const { readAccountCredentialRecord } = require('../lib/server/account-credential-store');
  const record = readAccountCredentialRecord(fs, aiHomeDir, accountRef);
  assert.equal(record.nativeAuth.oauthCreds.access_token, 'cli-token');
  const session = readDesktopSession(record);
  assert.equal(session.accessToken, 'web-access');
  assert.equal(session.refreshToken, 'web-refresh');
  assert.equal(session.userId, 'u-9');
  assert.equal(session.updatedAtMs > 0, true);
});

test('ensureDesktopSessionAccessToken 在 access 未过期时不发起续期', async (t) => {
  const { aiHomeDir, accountRef } = createStoreFixture(t);
  writeDesktopSession(fs, aiHomeDir, accountRef, {
    accessToken: makeJwt(Math.floor(Date.now() / 1000) + 600),
    refreshToken: 'web-refresh',
    userId: 'u-1'
  });
  const { calls, fetchImpl } = createFetchMock([{ status: 200, data: {} }]);
  const result = await ensureDesktopSessionAccessToken(fs, aiHomeDir, accountRef, { fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, false);
  assert.equal(calls.length, 0);
});

test('ensureDesktopSessionAccessToken 在 access 过期时续期并回写轮换 token', async (t) => {
  const { aiHomeDir, accountRef } = createStoreFixture(t);
  writeDesktopSession(fs, aiHomeDir, accountRef, {
    accessToken: makeJwt(Math.floor(Date.now() / 1000) - 10),
    refreshToken: 'old-refresh',
    userId: 'u-1'
  });
  const { fetchImpl } = createFetchMock([{
    status: 200,
    data: { access_token: makeJwt(Math.floor(Date.now() / 1000) + 900), refresh_token: 'rotated-refresh' }
  }]);
  const result = await ensureDesktopSessionAccessToken(fs, aiHomeDir, accountRef, {
    fetchImpl,
    authBaseUrl: 'https://auth.test/api'
  });
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);

  const { readAccountCredentialRecord } = require('../lib/server/account-credential-store');
  const session = readDesktopSession(readAccountCredentialRecord(fs, aiHomeDir, accountRef));
  assert.equal(session.accessToken, result.accessToken);
  assert.equal(session.refreshToken, 'rotated-refresh');
});

test('ensureDesktopSessionAccessToken 在续期被拒时不改动托管 session', async (t) => {
  const { aiHomeDir, accountRef } = createStoreFixture(t);
  writeDesktopSession(fs, aiHomeDir, accountRef, {
    accessToken: makeJwt(Math.floor(Date.now() / 1000) - 10),
    refreshToken: 'old-refresh',
    userId: 'u-1'
  });
  const result = await ensureDesktopSessionAccessToken(fs, aiHomeDir, accountRef, {
    fetchImpl: createFetchMock([{ status: 401, data: {} }]).fetchImpl,
    authBaseUrl: 'https://auth.test/api'
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'desktop_session_refresh_unauthorized');

  const { readAccountCredentialRecord } = require('../lib/server/account-credential-store');
  const session = readDesktopSession(readAccountCredentialRecord(fs, aiHomeDir, accountRef));
  assert.equal(session.refreshToken, 'old-refresh');
});

test('ensureDesktopSessionAccessToken 在无托管 session 时返回 desktop_session_missing', async (t) => {
  const { aiHomeDir, accountRef } = createStoreFixture(t);
  const result = await ensureDesktopSessionAccessToken(fs, aiHomeDir, accountRef, {
    fetchImpl: createFetchMock([{ status: 200, data: {} }]).fetchImpl
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'desktop_session_missing');
});
