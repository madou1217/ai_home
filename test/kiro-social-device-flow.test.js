'use strict';

// kiro **social 设备码**（Google / GitHub）回归 —— 「换台电脑也能登录」的那条路。
//
// 为什么与 Builder ID 的设备码分开测：两套协议只是外壳像，wire 形状处处不同 ——
// 端点主机（auth.desktop.kiro.dev vs oidc.<region>.amazonaws.com）、字段名
// （deviceCode/userCode 相同，但时长字段是毫秒 vs 秒）、**pending 的语义**
// （social 是 HTTP 200 + status 字段；OIDC 是 HTTP 400 + error 字段）。
// 混用会得到「未登录 / 无效客户端」这类看着像权限问题的假故障。
//
// 事实来源：官方 kiro-cli 二进制（crates/fig_auth/src/social.rs）与 2026-10-17 实测。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KIRO_SOCIAL_CLIENT_ID,
  KIRO_SOCIAL_PROVIDERS,
  normalizeLoginProvider,
  pollKiroSocialDeviceToken,
  resolveKiroSocialEndpoint,
  startKiroSocialDeviceAuthorization
} = require('../lib/account/kiro-social-device-flow');
const { resolveKiroTokenFlavour, KIRO_TOKEN_FLAVOURS } = require('../lib/account/kiro-token-flavour');

function recorder(handler) {
  const calls = [];
  return {
    calls,
    request: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return handler(url, init, calls.length);
    }
  };
}

test('端点与客户端标识：social 走 auth.desktop.kiro.dev，不是 AWS OIDC', () => {
  assert.equal(resolveKiroSocialEndpoint('us-east-1'), 'https://prod.us-east-1.auth.desktop.kiro.dev');
  // 非法 region 回落默认（与 desktop 刷新同一口径）。
  assert.equal(resolveKiroSocialEndpoint('bogus'), 'https://prod.us-east-1.auth.desktop.kiro.dev');
  assert.equal(KIRO_SOCIAL_CLIENT_ID, '820fd6d1-95c0-4ca4-bffb-3f01d32da842');
});

test('loginProvider 归一：google/github 两种写法都认，认不出回落 Google', () => {
  assert.equal(normalizeLoginProvider('Google'), KIRO_SOCIAL_PROVIDERS.GOOGLE);
  assert.equal(normalizeLoginProvider('google'), KIRO_SOCIAL_PROVIDERS.GOOGLE);
  assert.equal(normalizeLoginProvider('github'), KIRO_SOCIAL_PROVIDERS.GITHUB);
  assert.equal(normalizeLoginProvider('Github'), KIRO_SOCIAL_PROVIDERS.GITHUB);
  assert.equal(normalizeLoginProvider(''), KIRO_SOCIAL_PROVIDERS.GOOGLE);
  assert.equal(normalizeLoginProvider('wechat'), KIRO_SOCIAL_PROVIDERS.GOOGLE);
});

test('开始设备授权：毫秒时长换算成秒，verificationUriComplete 原样带回', async () => {
  const { request, calls } = recorder(() => ({
    status: 200,
    json: async () => ({
      deviceCode: 'DEV-1',
      userCode: 'WWTZ-VKPW',
      verificationUri: 'https://app.kiro.dev/account/device',
      verificationUriComplete: 'https://app.kiro.dev/account/device?user_code=WWTZ-VKPW&login_provider=Google',
      expiresInMilliseconds: 300000,
      intervalInMilliseconds: 5000
    })
  }));
  const started = await startKiroSocialDeviceAuthorization({ loginProvider: 'Google' }, { request });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/authorization');
  assert.deepEqual(calls[0].body, { clientId: KIRO_SOCIAL_CLIENT_ID, loginProvider: 'Google' });
  assert.equal(started.deviceCode, 'DEV-1');
  assert.equal(started.userCode, 'WWTZ-VKPW');
  // 毫秒 → 秒：照抄 OIDC 口径（秒）会让轮询快 1000 倍。
  assert.equal(started.intervalSeconds, 5);
  assert.equal(started.expiresInSeconds, 300);
  assert.match(started.verificationUriComplete, /user_code=WWTZ-VKPW/);
});

test('开始设备授权：非 200 / 缺字段都归到 kiro_social_* 错误码', async () => {
  const failed = recorder(() => ({ status: 500, json: async () => ({}) }));
  await assert.rejects(
    () => startKiroSocialDeviceAuthorization({}, { request: failed.request }),
    (error) => error.code === 'kiro_social_start_http_500'
  );

  const incomplete = recorder(() => ({ status: 200, json: async () => ({ deviceCode: 'D' }) }));
  await assert.rejects(
    () => startKiroSocialDeviceAuthorization({}, { request: incomplete.request }),
    (error) => error.code === 'kiro_social_start_missing_codes'
  );
});

test('轮询：pending 是 HTTP 200 + status 字段（与 OIDC 的 400 + error 口径相反）', async () => {
  const { request } = recorder(() => ({
    status: 200,
    json: async () => ({ accessToken: null, refreshToken: null, profileArn: null, status: 'authorization_pending' })
  }));
  const polled = await pollKiroSocialDeviceToken({ deviceCode: 'DEV-1' }, { request });
  assert.deepEqual(polled, { status: 'pending' });
});

test('轮询：invalid_token 读成 expired（设备码失效，不是错误）', async () => {
  const { request } = recorder(() => ({
    status: 200,
    json: async () => ({ accessToken: null, refreshToken: null, profileArn: null, status: 'invalid_token' })
  }));
  const polled = await pollKiroSocialDeviceToken({ deviceCode: 'DEV-1' }, { request });
  assert.deepEqual(polled, { status: 'expired' });
});

test('轮询：授权成功带回 access/refresh/profileArn/identityProvider', async () => {
  const { request, calls } = recorder(() => ({
    status: 200,
    json: async () => ({
      accessToken: 'aoa-social',
      refreshToken: 'aor-social',
      profileArn: 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK',
      identityProvider: 'Google',
      status: 'success'
    })
  }));
  const polled = await pollKiroSocialDeviceToken({ deviceCode: 'DEV-1' }, { request });

  assert.equal(calls[0].url, 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/device/poll');
  assert.deepEqual(calls[0].body, { clientId: KIRO_SOCIAL_CLIENT_ID, deviceCode: 'DEV-1' });
  assert.equal(polled.status, 'authorized');
  assert.equal(polled.grant.accessToken, 'aoa-social');
  assert.equal(polled.grant.refreshToken, 'aor-social');
  assert.equal(polled.profileArn, 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK');
  assert.equal(polled.provider, 'Google');
});

test('轮询：未知状态 / 缺 token 一律报错，绝不把空凭据写进账号', async () => {
  const unknown = recorder(() => ({
    status: 200,
    json: async () => ({ accessToken: 'a', refreshToken: 'r', status: 'something_new' })
  }));
  // 有 token 的未知状态按成功处理（上游加新状态时不该把有效凭据丢掉）。
  const ok = await pollKiroSocialDeviceToken({ deviceCode: 'D' }, { request: unknown.request });
  assert.equal(ok.status, 'authorized');

  const empty = recorder(() => ({
    status: 200,
    json: async () => ({ accessToken: null, refreshToken: null, status: 'weird' })
  }));
  await assert.rejects(
    () => pollKiroSocialDeviceToken({ deviceCode: 'D' }, { request: empty.request }),
    (error) => error.code === 'kiro_social_poll_unexpected_status:weird'
  );
});

test('产出的 auth 行判型为 desktop —— 刷新走 social 口径，不会被猜成 odic', () => {
  // 与 importKiroRefreshToken 同构：authMethod='social' + provider + profileArn。
  const nativeAuth = {
    auth: {
      access_token: 'a',
      refresh_token: 'r',
      authMethod: 'social',
      provider: 'Google',
      profileArn: 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'
    }
  };
  assert.equal(resolveKiroTokenFlavour(nativeAuth).flavour, KIRO_TOKEN_FLAVOURS.DESKTOP);
  // 显式 flavor（由 authSlot 落库）优先于任何标记推断。
  assert.equal(
    resolveKiroTokenFlavour({ ...nativeAuth, flavor: 'social' }).flavour,
    KIRO_TOKEN_FLAVOURS.DESKTOP
  );
});

// ── 槽位读取：这是「web 上 pro+、aih 显示 free」的根因修复 ──────────────────────────
//
// kiro CLI 有三个凭据槽（odic / social / external-idp），对应三种登录身份。
// 只读 odic 槽会把「本机用 Google 登录」的账号读成 Builder ID，从而拿到 FREE 权益。

test('槽位读取：social 槽的 token 能读到（以前只读 odic 槽会漏掉）', () => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readKiroTokenRecord, readKiroTokenFromDatabase } = require('../lib/account/kiro-auth-metadata');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-slots-'));
  const dbPath = path.join(dir, 'data.sqlite3');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
  const insert = db.prepare('INSERT INTO auth_kv(key, value) VALUES(?, ?)');
  insert.run('kirocli:social:token', JSON.stringify({
    access_token: 'aoa-social',
    refresh_token: 'aor-social',
    profile_arn: 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'
  }));
  db.close();

  try {
    const record = readKiroTokenRecord(dbPath);
    assert.equal(record.slot, 'kirocli:social:token');
    assert.equal(record.token.access_token, 'aoa-social');
    // 既有签名保持不变：只要 token 的调用方不需要改。
    assert.equal(readKiroTokenFromDatabase(dbPath).refresh_token, 'aor-social');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('槽位读取：odic 优先于 social（与官方 CLI 的检查顺序一致）', () => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readKiroTokenRecord } = require('../lib/account/kiro-auth-metadata');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-slots-'));
  const dbPath = path.join(dir, 'data.sqlite3');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
  const insert = db.prepare('INSERT INTO auth_kv(key, value) VALUES(?, ?)');
  insert.run('kirocli:odic:token', JSON.stringify({ access_token: 'aoa-odic', refresh_token: 'aor-odic' }));
  insert.run('kirocli:social:token', JSON.stringify({ access_token: 'aoa-social', refresh_token: 'aor-social' }));
  db.close();

  try {
    const record = readKiroTokenRecord(dbPath);
    assert.equal(record.slot, 'kirocli:odic:token');
    assert.equal(record.token.access_token, 'aoa-odic');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('槽位读取：三槽全空返回 null（不是空对象）', () => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readKiroTokenRecord } = require('../lib/account/kiro-auth-metadata');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-slots-'));
  const dbPath = path.join(dir, 'data.sqlite3');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
  db.close();
  try {
    assert.equal(readKiroTokenRecord(dbPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('槽名归一成 flavor 后判型正确（social/external-idp → desktop）', () => {
  const { resolveKiroTokenFlavour: resolve } = require('../lib/account/kiro-token-flavour');
  const { getProviderCredentialStrategy } = require('../lib/account/provider-credentials');
  const strategy = getProviderCredentialStrategy('kiro');

  // 槽 → flavor → 判型，整条链走通：这是「social 账号下次刷新不打错端点」的保证。
  for (const [slot, expected] of [
    ['kirocli:odic:token', KIRO_TOKEN_FLAVOURS.OIDC],
    ['kirocli:social:token', KIRO_TOKEN_FLAVOURS.DESKTOP],
    ['kirocli:external-idp:token', KIRO_TOKEN_FLAVOURS.DESKTOP]
  ]) {
    const normalized = strategy.normalizeFlavor({ auth: { access_token: 'a' }, authSlot: slot });
    assert.equal(normalized.flavor, slot === 'kirocli:odic:token' ? 'odic' : slot.split(':')[1]);
    assert.equal(normalized.authSlot, undefined, 'authSlot 是读取中间产物，不应落库');
    assert.equal(resolve(normalized).flavour, expected, `${slot} 应判为 ${expected}`);
  }
  // 老账号（没有 authSlot）不归一，走原有推断，行为不变。
  assert.equal(strategy.normalizeFlavor({ auth: { access_token: 'a' } }), null);
});
