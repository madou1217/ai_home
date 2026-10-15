'use strict';

// kiro「不装 CLI 也能加账号」的登录服务回归。
//
// 关键不变量：纯 API 产出的投影必须与本地 CLI 登录产出的投影**逐字段同构** ——
// 既有的 readKiroTokenFromDatabase / resolveKiroDeviceRegistration / 口径判型
// 读同一份 sqlite 必须得到同样结论，否则下游（采集、模型、推理）还得再改一遍。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  KEY_DEVICE_REGISTRATION,
  KEY_TOKEN,
  beginKiroDeviceLogin,
  buildKiroAuthRow,
  commitKiroCredential,
  importKiroRefreshToken,
  pollKiroDeviceLogin,
  writeKiroCredentialDatabase
} = require('../lib/account/kiro-device-login');
const { readKiroTokenFromDatabase } = require('../lib/account/kiro-auth-metadata');
const { resolveKiroDeviceRegistration } = require('../lib/account/kiro-device-registration');
const { resolveKiroTokenFlavour, KIRO_TOKEN_FLAVOURS } = require('../lib/account/kiro-token-flavour');

const REGISTRATION = {
  clientId: 'client-id', clientSecret: 'client-secret', clientSecretExpiresAt: '2027-01-04T11:25:18Z',
  region: 'us-east-1', oauthFlow: 'DeviceCode', scopes: ['codewhisperer:conversations']
};
const GRANT = {
  accessToken: 'aoa-access', refreshToken: 'aor-refresh', expiresAtMs: Date.parse('2030-01-01T00:00:00Z'),
  region: 'us-east-1'
};

function tempRuntime() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-login-'));
}

test('设备码投影：写出的 data.sqlite3 能被既有 CLI 侧读取器原样读懂（逐字段同构）', () => {
  const runtimeDir = tempRuntime();
  try {
    const databasePath = path.join(runtimeDir, 'data.sqlite3');
    const written = writeKiroCredentialDatabase(fs, databasePath, {
      registration: REGISTRATION, auth: buildKiroAuthRow(GRANT)
    });
    assert.deepEqual(written.keys, [KEY_DEVICE_REGISTRATION, KEY_TOKEN]);

    const token = readKiroTokenFromDatabase(databasePath);
    assert.equal(token.access_token, 'aoa-access');
    assert.equal(token.refresh_token, 'aor-refresh');
    assert.equal(token.region, 'us-east-1');
    assert.equal(token.expires_at, new Date(GRANT.expiresAtMs).toISOString());

    // 既有 device-registration 解析器直接可用（含 base64 sqlite 形态）。
    const resolved = resolveKiroDeviceRegistration({ database: fs.readFileSync(databasePath).toString('base64') });
    assert.equal(resolved.registration.clientId, 'client-id');
    assert.equal(resolved.registration.clientSecret, 'client-secret');
    assert.deepEqual(resolved.registration.scopes, ['codewhisperer:conversations']);

    // 权限 0600：client_secret 是长期凭据，不能让同机其它用户读到。
    assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600);

    // 口径判型得到 oidc（有 device-registration）。
    const nativeAuth = {
      database: fs.readFileSync(databasePath).toString('base64'),
      auth: readKiroTokenFromDatabase(databasePath)
    };
    assert.equal(resolveKiroTokenFlavour(nativeAuth).flavour, KIRO_TOKEN_FLAVOURS.OIDC);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('refreshToken 投影（B）：只有 token 行，social 标记让判型走 desktop 而不是 oidc', () => {
  const runtimeDir = tempRuntime();
  try {
    const databasePath = path.join(runtimeDir, 'data.sqlite3');
    writeKiroCredentialDatabase(fs, databasePath, {
      registration: null,
      auth: buildKiroAuthRow(GRANT, { authMethod: 'social', provider: 'Google', profileArn: 'arn:profile/social' })
    });
    // 没有 device-registration 行：OIDC 解析器必须拿不到它（否则会拿错的 client 去刷新）。
    assert.equal(resolveKiroDeviceRegistration({
      database: fs.readFileSync(databasePath).toString('base64')
    }).error, 'kiro_registration_missing');

    const nativeAuth = { database: fs.readFileSync(databasePath).toString('base64'),
      auth: readKiroTokenFromDatabase(databasePath) };
    assert.equal(resolveKiroTokenFlavour(nativeAuth).flavour, KIRO_TOKEN_FLAVOURS.DESKTOP);
    assert.equal(nativeAuth.auth.profileArn, 'arn:profile/social');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('beginKiroDeviceLogin + pollKiroDeviceLogin：拿到 code/URL，pending 不是错误，超时即 expired', async () => {
  const responses = [
    { status: 200, json: async () => ({ clientId: 'cid', clientSecret: 'secret' }) },
    { status: 200, json: async () => ({ deviceCode: 'd', userCode: 'WXYZ-1234',
      verificationUri: 'https://view.awsapps.com/start/#/device',
      verificationUriComplete: 'https://view.awsapps.com/start/#/device?user_code=WXYZ-1234',
      interval: 5, expiresIn: 600 }) },
    { status: 400, json: async () => ({ error: 'authorization_pending' }) },
    { status: 200, json: async () => ({ accessToken: 'aoa-device', refreshToken: 'aor-device', expiresIn: 3600 }) }
  ];
  let index = 0;
  const request = async () => responses[index++];

  const flow = await beginKiroDeviceLogin({ request });
  assert.equal(flow.userCode, 'WXYZ-1234');
  assert.equal(flow.verificationUriComplete, 'https://view.awsapps.com/start/#/device?user_code=WXYZ-1234');
  assert.equal(flow.intervalSeconds, 5);
  assert.equal(flow.registration.clientId, 'cid');

  assert.equal((await pollKiroDeviceLogin(flow, { request })).status, 'pending');
  const authorized = await pollKiroDeviceLogin(flow, { request });
  assert.equal(authorized.status, 'authorized');
  assert.equal(authorized.grant.accessToken, 'aoa-device');

  // 过期的流程直接报 expired，不再打上游。
  const expired = await pollKiroDeviceLogin({ ...flow, expiresAtMs: Date.now() - 1 },
    { request: async () => { throw new Error('must_not_call_upstream'); } });
  assert.equal(expired.status, 'expired');
  await assert.rejects(() => pollKiroDeviceLogin({}, {}),
    (error) => error.code === 'kiro_device_flow_missing_state');
});

test('importKiroRefreshToken（B）：先真刷一次再落库，带上 social 标记与 profileArn', async () => {
  const seen = [];
  const imported = await importKiroRefreshToken({
    refreshToken: 'aor-ide',
    request: async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body) });
      return { status: 200, json: async () => ({ accessToken: 'aoa-ide', expiresIn: 3600,
        profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/ide' }) };
    }
  });
  assert.equal(seen[0].url, 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken');
  assert.deepEqual(seen[0].body, { refreshToken: 'aor-ide' });
  assert.equal(imported.flavour, 'desktop');
  assert.equal(imported.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/ide');
  assert.equal(imported.auth.authMethod, 'social');
  assert.equal(imported.auth.access_token, 'aoa-ide');
  assert.equal(imported.auth.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/ide');

  await assert.rejects(() => importKiroRefreshToken({}),
    (error) => error.code === 'kiro_desktop_refresh_missing_refresh_token');
  // 刷新失败就不落库（不给账号写一份用不了的凭据）。
  await assert.rejects(() => importKiroRefreshToken({ refreshToken: 'aor-bad',
    request: async () => ({ status: 403, json: async () => ({}) }) }),
  (error) => error.code === 'kiro_desktop_refresh_unauthorized');
});

test('commitKiroCredential：投影写进 runtimeDir 后交给既有注册链路，失败带原因不谎报成功', async () => {
  const runtimeDir = tempRuntime();
  try {
    const calls = [];
    const ok = await commitKiroCredential(fs, {
      runtimeDir, aiHomeDir: '/tmp/aih-kiro-login',
      registration: REGISTRATION, auth: buildKiroAuthRow(GRANT),
      registerKiroNativeLogin: async (targetFs, dir, options) => {
        calls.push({ dir, accountRef: options.accountRef, hasRequest: typeof options.request === 'function' });
        assert.ok(targetFs.existsSync(path.join(dir, 'data.sqlite3')), '注册前投影必须已落盘');
        return { registered: true, accountRef: 'acct_new', cliAccountId: '7' };
      }
    });
    assert.deepEqual(ok, { ok: true, accountRef: 'acct_new', cliAccountId: '7',
      databasePath: path.join(runtimeDir, 'data.sqlite3') });
    assert.deepEqual(calls, [{ dir: runtimeDir, accountRef: undefined, hasRequest: true }]);

    const failed = await commitKiroCredential(fs, {
      runtimeDir, registration: REGISTRATION, auth: buildKiroAuthRow(GRANT),
      registerKiroNativeLogin: async () => ({ registered: false, reason: 'account_identity_mismatch' })
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.reason, 'account_identity_mismatch');

    await assert.rejects(() => commitKiroCredential(fs, { registration: REGISTRATION, auth: buildKiroAuthRow(GRANT) }),
      (error) => error.code === 'kiro_login_runtime_missing');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
