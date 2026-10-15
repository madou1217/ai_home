'use strict';

// kiro「不依赖本地 CLI / IDE」的**第二条凭据口径**回归：Kiro Desktop / social（Google / GitHub）。
//
// 背景：`d4e082a2` 把采集做成了纯 API，但账号进入系统仍必须先跑一次本地 `kiro-cli login`，
// 再从它的 sqlite 里抄 device-registration + grant。social 登录（Kiro IDE）的账号根本没有
// device-registration，只有 refresh_token —— 它走的是另一条上游口径：
//   POST https://prod.<region>.auth.desktop.kiro.dev/refreshToken  { "refreshToken": "..." }
// 本文件守住：口径判型只有一处、两条口径共用同一份 grant 形状、profileArn 会被带上与落库。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  refreshKiroDesktopGrant,
  resolveKiroDesktopRefreshEndpoint
} = require('../lib/account/kiro-desktop-refresh');
const { refreshKiroToken } = require('../lib/account/kiro-token-refresh');
const { KIRO_TOKEN_FLAVOURS, resolveKiroTokenFlavour } = require('../lib/account/kiro-token-flavour');
const { ensureFreshKiroGrant } = require('../lib/account/kiro-grant-store');
const { fetchKiroUsageLimits } = require('../lib/account/kiro-usage-client');
const {
  fetchKiroProfiles,
  readKiroProfileArn,
  resolveKiroProfileArn
} = require('../lib/account/kiro-profile');

const DESKTOP_AUTH = {
  access_token: 'aoa-old',
  refresh_token: 'aor-social-refresh',
  region: 'us-east-1',
  authMethod: 'social',
  provider: 'Google'
};
const REGISTRATION = {
  client_id: 'client-id-1234567890',
  client_secret: 'client-secret-value',
  region: 'us-east-1',
  oauth_flow: 'DeviceCode',
  scopes: ['codewhisperer:conversations']
};
const DOCUMENT = {
  userInfo: { userId: 'kiro-user', email: 'kiro@example.invalid' },
  subscriptionInfo: { type: 'Q_DEVELOPER_STANDALONE_FREE', subscriptionTitle: 'KIRO FREE' },
  usageBreakdownList: [{ resourceType: 'CREDIT', usageLimit: 50, currentUsageWithPrecision: 0.13,
    usageLimitWithPrecision: 50 }]
};

function desktopRequest(handler) {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null, headers: init && init.headers });
    return handler(url, init);
  };
  return { request, calls };
}

test('desktop 刷新端点：只有 us-east-1 有 DNS 记录，非法 region 回落到默认值', () => {
  assert.equal(resolveKiroDesktopRefreshEndpoint('us-east-1'),
    'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken');
  assert.equal(resolveKiroDesktopRefreshEndpoint(''), 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken');
  assert.equal(resolveKiroDesktopRefreshEndpoint('not-a-region'),
    'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken');
});

test('desktop 刷新：只要 refresh_token（没有 client_secret），profileArn 一并带回', async () => {
  const { request, calls } = desktopRequest(() => ({
    status: 200,
    json: async () => ({ accessToken: 'aoa-new', refreshToken: 'aor-rotated', expiresIn: 3600,
      profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/social' })
  }));
  const grant = await refreshKiroDesktopGrant({ refreshToken: 'aor-social-refresh' }, { request });
  assert.deepEqual(calls[0].body, { refreshToken: 'aor-social-refresh' });
  assert.equal(JSON.stringify(calls[0].body).includes('client_secret'), false);
  assert.equal(grant.accessToken, 'aoa-new');
  assert.equal(grant.refreshToken, 'aor-rotated');
  assert.equal(grant.profileArn, 'arn:aws:codewhisperer:us-east-1:123456789012:profile/social');
  assert.equal(grant.region, 'us-east-1');
  assert.ok(grant.expiresAtMs > Date.now());
});

test('desktop 刷新：未轮换时沿用旧 refresh_token；缺 token / 401 / 403 / 500 各有明确错误码', async () => {
  const { request } = desktopRequest(() => ({ status: 200, json: async () => ({ accessToken: 'aoa-new', expiresIn: 60 }) }));
  assert.equal((await refreshKiroDesktopGrant({ refreshToken: 'aor-keep' }, { request })).refreshToken, 'aor-keep');

  await assert.rejects(() => refreshKiroDesktopGrant({}, { request }),
    (error) => error.code === 'kiro_desktop_refresh_missing_refresh_token');
  for (const [status, code] of [[401, 'kiro_desktop_refresh_unauthorized'],
    [403, 'kiro_desktop_refresh_unauthorized'], [500, 'kiro_desktop_refresh_http_500']]) {
    const failing = desktopRequest(() => ({ status, json: async () => ({}) }));
    await assert.rejects(
      () => refreshKiroDesktopGrant({ refreshToken: 'aor' }, { request: failing.request }),
      (error) => error.code === code
    );
  }
  const empty = desktopRequest(() => ({ status: 200, json: async () => ({}) }));
  await assert.rejects(() => refreshKiroDesktopGrant({ refreshToken: 'aor' }, { request: empty.request }),
    (error) => error.code === 'kiro_desktop_refresh_missing_access_token');
});

test('口径判型只有一处：显式 > registration > social 标记 > 默认 oidc', () => {
  assert.deepEqual(resolveKiroTokenFlavour({ flavor: 'desktop', registration: REGISTRATION }),
    { flavour: KIRO_TOKEN_FLAVOURS.DESKTOP, reason: 'explicit' });
  assert.deepEqual(resolveKiroTokenFlavour({ registration: REGISTRATION }),
    { flavour: KIRO_TOKEN_FLAVOURS.OIDC, reason: 'registration' });
  assert.deepEqual(resolveKiroTokenFlavour({ auth: DESKTOP_AUTH }),
    { flavour: KIRO_TOKEN_FLAVOURS.DESKTOP, reason: 'desktop_markers' });
  // 只有 profileArn 也算 social 标记（Kiro IDE 的 kiro-auth-token.json 就带它）。
  assert.equal(resolveKiroTokenFlavour({ auth: { profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/x' } }).flavour,
    KIRO_TOKEN_FLAVOURS.DESKTOP);
  // 什么都没写 → 保持旧行为（oidc 失败后切 CLI 兜底），不静默换口径。
  assert.deepEqual(resolveKiroTokenFlavour({ auth: { access_token: 'a', refresh_token: 'r', region: 'us-east-1' } }),
    { flavour: KIRO_TOKEN_FLAVOURS.OIDC, reason: 'default' });
  // 内嵌 sqlite 里的 registration 也算 oidc（历史导入形态行为不变）。
  assert.equal(resolveKiroTokenFlavour({ auth: { region: 'us-east-1' } },
    { resolveKiroDeviceRegistration: () => ({ registration: REGISTRATION }) }).reason, 'embedded_registration');
});

test('refreshKiroToken 按判型选口径：desktop 打 desktop 端点，oidc 打 OIDC 端点', async () => {
  const { request, calls } = desktopRequest(() => ({ status: 200, json: async () => ({ accessToken: 'aoa-d', expiresIn: 60 }) }));
  const desktop = await refreshKiroToken({ nativeAuth: { auth: DESKTOP_AUTH }, refreshToken: 'aor-social-refresh' }, { request });
  assert.equal(calls[0].url, 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken');
  assert.equal(desktop.flavour, KIRO_TOKEN_FLAVOURS.DESKTOP);

  const oidc = await refreshKiroToken({
    nativeAuth: { auth: DESKTOP_AUTH, registration: REGISTRATION },
    refreshToken: 'aor-oidc'
  }, { request: async (url) => {
    calls.push({ url });
    return { status: 200, json: async () => ({ accessToken: 'aoa-o', expiresIn: 60 }) };
  } });
  assert.equal(calls[1].url, 'https://oidc.us-east-1.amazonaws.com/token');
  assert.equal(oidc.flavour, KIRO_TOKEN_FLAVOURS.OIDC);
});

test('ensureFreshKiroGrant（desktop）：只要 refresh_token 就能自刷新，并落库口径与 profileArn', async () => {
  const written = [];
  const record = {
    accountRef: 'acct_desktop',
    provider: 'kiro',
    nativeAuth: { auth: { ...DESKTOP_AUTH, expires_at: new Date(Date.now() - 86_400_000).toISOString() } }
  };
  const result = await ensureFreshKiroGrant(record, {
    fs: {}, aiHomeDir: '/tmp/aih-kiro-desktop',
    compareAndSwapAccountNativeAuth: (_fs, _dir, ref, expected, next) => {
      written.push({ ref, next });
      return true;
    },
    refreshKiroDesktopGrant: async (input) => {
      assert.equal(input.refreshToken, 'aor-social-refresh');
      return { accessToken: 'aoa-fresh', refreshToken: 'aor-social-refresh', expiresAtMs: Date.now() + 3600_000,
        region: 'us-east-1', profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/social' };
    }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.flavour, KIRO_TOKEN_FLAVOURS.DESKTOP);
  assert.equal(result.record.nativeAuth.auth.access_token, 'aoa-fresh');
  assert.equal(written[0].ref, 'acct_desktop');
  assert.equal(written[0].next.flavor, KIRO_TOKEN_FLAVOURS.DESKTOP);
  assert.equal(written[0].next.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/social');
  assert.equal('registration' in written[0].next, false, 'desktop 账号不该被写入 registration');
});

test('ensureFreshKiroGrant（oidc）：行为与修复前一致 —— 落 registration 与口径，grant 形状不变', async () => {
  const written = [];
  const record = {
    accountRef: 'acct_oidc',
    provider: 'kiro',
    nativeAuth: { registration: REGISTRATION,
      auth: { access_token: 'aoa-old', refresh_token: 'aor-oidc', region: 'us-east-1',
        expires_at: new Date(Date.now() - 86_400_000).toISOString() } }
  };
  const result = await ensureFreshKiroGrant(record, {
    fs: {}, aiHomeDir: '/tmp/aih-kiro-oidc',
    compareAndSwapAccountNativeAuth: (_fs, _dir, ref, expected, next) => { written.push({ ref, next }); return true; },
    refreshKiroGrant: async () => ({ accessToken: 'aoa-oidc-new', refreshToken: 'aor-oidc',
      expiresAtMs: Date.now() + 3600_000, region: 'us-east-1' })
  });
  assert.equal(result.flavour, KIRO_TOKEN_FLAVOURS.OIDC);
  assert.equal(written[0].next.flavor, KIRO_TOKEN_FLAVOURS.OIDC);
  assert.equal(written[0].next.registration.clientId, 'client-id-1234567890');
  assert.equal(written[0].next.auth.access_token, 'aoa-oidc-new');
});

test('ensureFreshKiroGrant：token 仍新鲜时一次网络都不发（两条口径共用）', async () => {
  let refreshed = 0;
  const result = await ensureFreshKiroGrant({
    accountRef: 'acct_fresh', provider: 'kiro',
    nativeAuth: { auth: { ...DESKTOP_AUTH, expires_at: new Date(Date.now() + 3600_000).toISOString() } }
  }, { refreshKiroDesktopGrant: async () => { refreshed += 1; } });
  assert.equal(result.refreshed, false);
  assert.equal(refreshed, 0);
});

test('GetUsageLimits：凭据带 profileArn 时同时进 query 与 body（IdC / social 必需）', async () => {
  const seen = [];
  const request = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(DOCUMENT));
  };
  await fetchKiroUsageLimits({ auth: DESKTOP_AUTH, profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/social' }, { request });
  assert.match(seen[0].url, /profileArn=arn%3Aaws%3Acodewhisperer/);
  assert.equal(seen[0].body.profileArn, 'arn:aws:codewhisperer:us-east-1:1:profile/social');

  const bare = [];
  await fetchKiroUsageLimits({ auth: DESKTOP_AUTH }, { request: async (url, init) => {
    bare.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(DOCUMENT));
  } });
  assert.equal(bare[0].url.includes('profileArn'), false);
  assert.equal('profileArn' in bare[0].body, false);
});

test('profileArn 解析：凭据里带了就用（不发请求），没有就列一次；多个时绝不替用户猜', async () => {
  assert.equal(readKiroProfileArn({ profileArn: 'arn:cred' }), 'arn:cred');
  assert.equal(readKiroProfileArn({ auth: { profileArn: 'arn:auth' } }), 'arn:auth');

  let calls = 0;
  const fromCredential = await resolveKiroProfileArn({ profileArn: 'arn:cred' },
    { fetchKiroProfiles: async () => { calls += 1; return { profiles: [] }; } });
  assert.equal(fromCredential.source, 'credential');
  assert.equal(calls, 0);

  const single = await resolveKiroProfileArn({ auth: DESKTOP_AUTH },
    { fetchKiroProfiles: async () => ({ profiles: [{ arn: 'arn:only', name: 'BuilderId' }] }) });
  assert.deepEqual(single, { profileArn: 'arn:only', source: 'listed' });

  const ambiguous = await resolveKiroProfileArn({ auth: DESKTOP_AUTH },
    { fetchKiroProfiles: async () => ({ profiles: [{ arn: 'arn:a', name: 'A' }, { arn: 'arn:b', name: 'B' }] }) });
  assert.equal(ambiguous.error, 'kiro_profile_ambiguous');
  assert.deepEqual(ambiguous.profiles.map((profile) => profile.arn), ['arn:a', 'arn:b']);

  const none = await resolveKiroProfileArn({ auth: DESKTOP_AUTH },
    { fetchKiroProfiles: async () => ({ profiles: [] }) });
  assert.equal(none.error, 'kiro_profile_missing');
});

test('ListAvailableProfiles：同一端点同一套头，响应键名兼容 arn / profileArn', async () => {
  const seen = [];
  const result = await fetchKiroProfiles({ access_token: 'tok', region: 'us-east-1' }, {
    request: async (url, init) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { status: 200, text: async () => JSON.stringify({ profiles: [
        { arn: 'arn:one', profileName: 'One' }, { profileArn: 'arn:two' }, { profileName: 'no-arn' }] }) };
    }
  });
  assert.equal(seen[0].url, 'https://codewhisperer.us-east-1.amazonaws.com/');
  assert.equal(seen[0].headers['x-amz-target'], 'AmazonCodeWhispererService.ListAvailableProfiles');
  assert.equal(seen[0].headers.authorization, 'Bearer tok');
  assert.deepEqual(seen[0].body, { origin: 'CLI' });
  assert.deepEqual(result.profiles, [{ arn: 'arn:one', name: 'One' }, { arn: 'arn:two', name: '' }]);

  await assert.rejects(() => fetchKiroProfiles({ access_token: 'tok' }, {
    request: async () => ({ status: 403, text: async () => '' })
  }), (error) => error.code === 'kiro_profiles_http_403');
  await assert.rejects(() => fetchKiroProfiles({}, { request: async () => ({ status: 200 }) }),
    (error) => error.code === 'kiro_profiles_missing_access_token');
});
