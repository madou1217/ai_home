'use strict';

// `aih kiro login --device-code | --refresh-token` 的回归。
//
// 守两件事：① 参数解析不静默吞错（未知 flag 必须报错）；② 设备码等待语义正确
// （pending 继续、slow_down 拉长间隔、超时即放弃），且登录成功后走的是既有注册契约。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseKiroNativeLoginArgs,
  runKiroNativeLogin,
  runKiroNativeLoginCommand,
  waitForKiroDeviceAuthorization
} = require('../lib/cli/services/account/kiro-native-login');
const { readKiroTokenFromDatabase } = require('../lib/account/kiro-auth-metadata');
const { resolveKiroDeviceRegistration } = require('../lib/account/kiro-device-registration');
const { resolveKiroTokenFlavour, KIRO_TOKEN_FLAVOURS } = require('../lib/account/kiro-token-flavour');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-cli-'));
}

test('参数解析：默认设备码；给 refresh-token 即切到 B；未知/缺值 flag 一律报错', () => {
  assert.deepEqual(parseKiroNativeLoginArgs(['--device-code']).mode, 'device-code');
  assert.equal(parseKiroNativeLoginArgs([]).mode, 'device-code');
  const imported = parseKiroNativeLoginArgs(['--refresh-token', 'aor-x', '--profile-arn', 'arn:y', '--region', 'eu-west-1']);
  assert.equal(imported.mode, 'refresh-token');
  assert.equal(imported.refreshToken, 'aor-x');
  assert.equal(imported.profileArn, 'arn:y');
  assert.equal(imported.region, 'eu-west-1');
  assert.equal(parseKiroNativeLoginArgs(['--timeout-ms', '30000']).timeoutMs, 30000);

  assert.equal(parseKiroNativeLoginArgs(['--device-code', '--bogus']).error, 'unknown_flag:--bogus');
  assert.equal(parseKiroNativeLoginArgs(['--region']).error, 'missing_value:--region');
  assert.equal(parseKiroNativeLoginArgs(['--refresh-token']).error, 'missing_refresh_token_value');
});

test('设备码等待：pending 继续、slow_down 拉长间隔、到点即 expired', async () => {
  const flow = { registration: { clientId: 'c', clientSecret: 's' }, deviceCode: 'd',
    intervalSeconds: 5, expiresAtMs: Date.now() + 60_000 };
  const sleeps = [];
  let call = 0;
  const result = await waitForKiroDeviceAuthorization(flow, {
    request: async () => {
      call += 1;
      if (call === 1) return { status: 400, json: async () => ({ error: 'authorization_pending' }) };
      if (call === 2) return { status: 400, json: async () => ({ error: 'slow_down' }) };
      return { status: 200, json: async () => ({ accessToken: 'aoa', refreshToken: 'aor', expiresIn: 3600 }) };
    },
    sleep: async (ms) => { sleeps.push(ms); }
  });
  assert.equal(result.status, 'authorized');
  assert.equal(result.grant.accessToken, 'aoa');
  // 第一次 5s，slow_down 后 +5s → 10s（RFC 8628）。
  assert.deepEqual(sleeps, [5000, 10000]);
  assert.equal(call, 3);

  const denied = await waitForKiroDeviceAuthorization(flow, {
    request: async () => ({ status: 400, json: async () => ({ error: 'access_denied' }) }),
    sleep: async () => {}
  });
  assert.equal(denied.status, 'denied');

  const timedOut = await waitForKiroDeviceAuthorization({ ...flow, expiresAtMs: Date.now() - 1 }, {
    request: async () => ({ status: 400, json: async () => ({ error: 'authorization_pending' }) }),
    sleep: async () => {}
  });
  assert.equal(timedOut.status, 'expired');
});

test('设备码登录（A）：打印验证地址与 code，成功后按既有契约注册账号', async () => {
  const aiHomeDir = tempHome();
  try {
    const responses = [
      { status: 200, json: async () => ({ clientId: 'cid', clientSecret: 'secret' }) },
      { status: 200, json: async () => ({ deviceCode: 'd', userCode: 'CODE-1234',
        verificationUri: 'https://view.awsapps.com/start/#/device',
        verificationUriComplete: 'https://view.awsapps.com/start/#/device?user_code=CODE-1234',
        interval: 5, expiresIn: 600 }) },
      { status: 400, json: async () => ({ error: 'authorization_pending' }) },
      { status: 200, json: async () => ({ accessToken: 'aoa-device', refreshToken: 'aor-device', expiresIn: 3600 }) }
    ];
    let index = 0;
    const lines = [];
    const committed = [];
    const result = await runKiroNativeLogin({
      fs, aiHomeDir, mode: 'device-code',
      request: async () => responses[index++],
      sleep: async () => {},
      log: (line) => lines.push(line),
      registerKiroNativeLogin: async (targetFs, runtimeDir, options) => {
        committed.push({ runtimeDir, hasRequest: typeof options.request === 'function' });
        const token = readKiroTokenFromDatabase(path.join(runtimeDir, 'data.sqlite3'));
        return { registered: true, accountRef: 'acct_1', cliAccountId: '3', token: token.access_token };
      }
    });

    assert.deepEqual(result, { ok: true, mode: 'device-code', accountRef: 'acct_1', cliAccountId: '3' });
    assert.ok(lines.some((line) => line.includes('https://view.awsapps.com/start/#/device?user_code=CODE-1234')));
    assert.ok(lines.some((line) => line.includes('CODE-1234')));
    assert.equal(committed.length, 1);
    assert.equal(committed[0].hasRequest, true, '身份核验必须拿到 request 端口');

    // 落盘形态：既有读取器能读懂，且判型为 oidc（设备码口径带 device-registration）。
    const databasePath = path.join(committed[0].runtimeDir, 'data.sqlite3');
    assert.equal(readKiroTokenFromDatabase(databasePath).access_token, 'aoa-device');
    const nativeAuth = { database: fs.readFileSync(databasePath).toString('base64'),
      auth: readKiroTokenFromDatabase(databasePath) };
    assert.equal(resolveKiroTokenFlavour(nativeAuth).flavour, KIRO_TOKEN_FLAVOURS.OIDC);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('刷新令牌登录（B）：不写 device-registration，判型为 desktop', async () => {
  const aiHomeDir = tempHome();
  try {
    const seen = [];
    const committed = [];
    const result = await runKiroNativeLogin({
      fs, aiHomeDir, mode: 'refresh-token', refreshToken: 'aor-ide',
      request: async (url, init) => {
        seen.push(url);
        return { status: 200, json: async () => ({ accessToken: 'aoa-ide', expiresIn: 3600,
          profileArn: 'arn:profile/ide' }) };
      },
      registerKiroNativeLogin: async (targetFs, runtimeDir) => {
        committed.push(runtimeDir);
        return { registered: true, accountRef: 'acct_2', cliAccountId: '4' };
      }
    });

    assert.equal(result.ok, true);
    assert.equal(seen[0], 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken');
    const databasePath = path.join(committed[0], 'data.sqlite3');
    const nativeAuth = { database: fs.readFileSync(databasePath).toString('base64'),
      auth: readKiroTokenFromDatabase(databasePath) };
    assert.equal(resolveKiroTokenFlavour(nativeAuth).flavour, KIRO_TOKEN_FLAVOURS.DESKTOP);
    assert.equal(resolveKiroDeviceRegistration(nativeAuth).error, 'kiro_registration_missing');
    assert.equal(nativeAuth.auth.profileArn, 'arn:profile/ide');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('命令层：用法错误返回 2、授权被拒返回 1、成功返回 0', async () => {
  const errors = [];
  assert.equal(await runKiroNativeLoginCommand({ argv: ['--nope'],
    errorLog: (line) => errors.push(line), log: () => {} }), 2);
  assert.ok(errors.some((line) => line.includes('unknown_flag:--nope')));

  const aiHomeDir = tempHome();
  try {
    // 授权被拒：注册与开始授权都正常，用户在浏览器里点了拒绝。
    const responses = [
      { status: 200, json: async () => ({ clientId: 'cid', clientSecret: 'secret' }) },
      { status: 200, json: async () => ({ deviceCode: 'd', userCode: 'U',
        verificationUri: 'https://view.awsapps.com/start/#/device', interval: 5, expiresIn: 600 }) },
      { status: 400, json: async () => ({ error: 'access_denied' }) }
    ];
    let index = 0;
    const denied = await runKiroNativeLoginCommand({
      fs, aiHomeDir, argv: ['--device-code'], log: () => {}, errorLog: (line) => errors.push(line),
      request: async () => responses[index++]
    });
    assert.equal(denied, 1);
    assert.ok(errors.some((line) => line.includes('denied')), errors.join('|'));
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});
