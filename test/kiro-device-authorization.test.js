'use strict';

// kiro 设备码授权（AWS SSO OIDC + RFC 8628）回归 —— 「不装 CLI / IDE 也能加账号」的那条路。
//
// 官方流程（aws/amazon-q-developer-cli 的 auth/builder_id.rs 与 auth/consts.rs）：
//   RegisterClient → StartDeviceAuthorization → 轮询 CreateToken
// 本文件把每一步的 wire 形状钉住：请求字段、默认值、pending/slow_down/expired/denied 的语义，
// 以及「产出的凭据与 CLI 导入完全同构」这件事（否则下游采集与推理还得再改一遍）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KIRO_BUILDER_ID_START_URL,
  KIRO_DEVICE_GRANT,
  KIRO_OIDC_SCOPES,
  pollKiroDeviceToken,
  registerKiroOidcClient,
  resolveKiroOidcEndpoint,
  startKiroDeviceAuthorization
} = require('../lib/account/kiro-device-authorization');
const { resolveKiroTokenFlavour, KIRO_TOKEN_FLAVOURS } = require('../lib/account/kiro-token-flavour');

const REGISTRATION = { clientId: 'client-id', clientSecret: 'client-secret', region: 'us-east-1' };

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

test('RegisterClient：public 客户端 + 官方 scopes + device/refresh 两种 grant', async () => {
  const { request, calls } = recorder(() => ({
    status: 200,
    json: async () => ({ clientId: 'cid', clientSecret: 'secret', clientSecretExpiresAt: 1793491200,
      clientIdIssuedAt: 1793487600 })
  }));
  const registration = await registerKiroOidcClient({}, { request });

  assert.equal(calls[0].url, 'https://oidc.us-east-1.amazonaws.com/client/register');
  assert.equal(calls[0].body.clientType, 'public');
  assert.deepEqual(calls[0].body.scopes, [...KIRO_OIDC_SCOPES]);
  assert.deepEqual(calls[0].body.grantTypes, [KIRO_DEVICE_GRANT, 'refresh_token']);
  assert.equal(calls[0].body.clientName, 'aih');
  // Builder ID 没有 IdC 实例，issuerUrl 必须缺席（带上会被上游拒）。
  assert.equal('issuerUrl' in calls[0].body, false);

  assert.deepEqual(registration, {
    clientId: 'cid',
    clientSecret: 'secret',
    clientSecretExpiresAt: new Date(1793491200 * 1000).toISOString(),
    region: 'us-east-1',
    oauthFlow: 'DeviceCode',
    scopes: [...KIRO_OIDC_SCOPES]
  });
});

test('RegisterClient：IdC 场景传 issuerUrl / region / clientName，失败与缺字段各有明确错误码', async () => {
  const { request, calls } = recorder(() => ({ status: 200, json: async () => ({ clientId: 'c', clientSecret: 's' }) }));
  const registration = await registerKiroOidcClient({
    region: 'eu-west-1', clientName: 'aih-test', issuerUrl: 'https://view.awsapps.com/start'
  }, { request });
  assert.equal(calls[0].url, 'https://oidc.eu-west-1.amazonaws.com/client/register');
  assert.equal(calls[0].body.issuerUrl, 'https://view.awsapps.com/start');
  assert.equal(calls[0].body.clientName, 'aih-test');
  assert.equal(registration.region, 'eu-west-1');
  assert.equal(registration.clientSecretExpiresAt, '', '上游没给有效期时留空，不编造时间');

  await assert.rejects(() => registerKiroOidcClient({}, {
    request: async () => ({ status: 400, json: async () => ({ error: 'invalid_client_metadata' }) })
  }), (error) => error.code === 'kiro_device_register_http_400');
  await assert.rejects(() => registerKiroOidcClient({}, {
    request: async () => ({ status: 200, json: async () => ({ clientId: 'only-id' }) })
  }), (error) => error.code === 'kiro_device_register_missing_client');
  // 非法 region 回落到默认（只有 us-east-1 保证可用）。
  assert.equal(resolveKiroOidcEndpoint('bogus'), 'https://oidc.us-east-1.amazonaws.com');
});

test('StartDeviceAuthorization：默认 Builder ID startUrl，返回给用户看的 code 与验证地址', async () => {
  const { request, calls } = recorder(() => ({
    status: 200,
    json: async () => ({ deviceCode: 'device-code', userCode: 'ABCD-EFGH',
      verificationUri: 'https://view.awsapps.com/start/#/device',
      verificationUriComplete: 'https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH',
      interval: 5, expiresIn: 600 })
  }));
  const started = await startKiroDeviceAuthorization({ registration: REGISTRATION }, { request });

  assert.equal(calls[0].url, 'https://oidc.us-east-1.amazonaws.com/device_authorization');
  assert.deepEqual(calls[0].body, {
    clientId: 'client-id', clientSecret: 'client-secret', startUrl: KIRO_BUILDER_ID_START_URL
  });
  assert.equal(started.deviceCode, 'device-code');
  assert.equal(started.userCode, 'ABCD-EFGH');
  assert.equal(started.verificationUriComplete, 'https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH');
  assert.equal(started.intervalSeconds, 5);
  assert.equal(started.expiresInSeconds, 600);
});

test('StartDeviceAuthorization：IdC 用调用方给的 portal URL；缺注册/缺字段 fail closed', async () => {
  const { request, calls } = recorder(() => ({ status: 200, json: async () => ({
    deviceCode: 'd', userCode: 'U', verificationUri: 'https://portal/device'
  }) }));
  const started = await startKiroDeviceAuthorization({
    registration: REGISTRATION, startUrl: 'https://my-company.awsapps.com/start'
  }, { request });
  assert.equal(calls[0].body.startUrl, 'https://my-company.awsapps.com/start');
  // 上游没给完整链接时退回 verificationUri；没给 interval/expiresIn 时用 RFC 8628 的保守默认。
  assert.equal(started.verificationUriComplete, 'https://portal/device');
  assert.equal(started.intervalSeconds, 5);
  assert.equal(started.expiresInSeconds, 600);

  await assert.rejects(() => startKiroDeviceAuthorization({}, { request }),
    (error) => error.code === 'kiro_device_missing_client_registration');
  await assert.rejects(() => startKiroDeviceAuthorization({ registration: REGISTRATION }, {
    request: async () => ({ status: 200, json: async () => ({ deviceCode: 'd' }) })
  }), (error) => error.code === 'kiro_device_start_missing_codes');
});

test('CreateToken 轮询：未批准是状态不是错误（pending / slow_down / expired / denied）', async () => {
  const pending = await pollKiroDeviceToken({ registration: REGISTRATION, deviceCode: 'd' }, {
    request: async () => ({ status: 400, json: async () => ({ error: 'authorization_pending' }) })
  });
  assert.deepEqual(pending, { status: 'pending' });

  for (const [upstream, expected] of [['slow_down', 'slow_down'], ['expired_token', 'expired'],
    ['access_denied', 'denied']]) {
    const result = await pollKiroDeviceToken({ registration: REGISTRATION, deviceCode: 'd' }, {
      request: async () => ({ status: 400, json: async () => ({ error: upstream }) })
    });
    assert.equal(result.status, expected);
  }

  // 已吊销/过期的 clientSecret 必须是错误：否则用户会一直等一个永远不会成功的授权。
  await assert.rejects(() => pollKiroDeviceToken({ registration: REGISTRATION, deviceCode: 'd' }, {
    request: async () => ({ status: 401, json: async () => ({ error: 'invalid_client' }) })
  }), (error) => error.code === 'kiro_device_invalid_client');
  await assert.rejects(() => pollKiroDeviceToken({ registration: REGISTRATION, deviceCode: 'd' }, {
    request: async () => ({ status: 500, json: async () => ({}) })
  }), (error) => error.code === 'kiro_device_token_http_500');
  await assert.rejects(() => pollKiroDeviceToken({ registration: REGISTRATION }, { request: async () => ({ status: 200 }) }),
    (error) => error.code === 'kiro_device_missing_device_code');
});

test('CreateToken 轮询：拿到 token 时返回统一 grant 形状（与 OIDC/desktop 刷新同一份）', async () => {
  const { request, calls } = recorder(() => ({
    status: 200,
    json: async () => ({ accessToken: 'aoa-access', refreshToken: 'aor-refresh', expiresIn: 3600, tokenType: 'Bearer' })
  }));
  const polled = await pollKiroDeviceToken({ registration: REGISTRATION, deviceCode: 'device-code' }, { request });

  assert.equal(calls[0].url, 'https://oidc.us-east-1.amazonaws.com/token');
  assert.deepEqual(calls[0].body, {
    clientId: 'client-id', clientSecret: 'client-secret', grantType: KIRO_DEVICE_GRANT, deviceCode: 'device-code'
  });
  assert.equal(polled.status, 'authorized');
  assert.equal(polled.grant.accessToken, 'aoa-access');
  assert.equal(polled.grant.refreshToken, 'aor-refresh');
  assert.equal(polled.grant.region, 'us-east-1');
  assert.ok(polled.grant.expiresAtMs > Date.now());
});

test('设备码登录的产出与 CLI 导入**同构**：下游判型/刷新不需要知道它是怎么来的', async () => {
  // 走完整三步（register → start → 先 pending 再 authorized），把产出拼成凭据记录。
  const sequence = [
    { status: 200, json: async () => ({ clientId: 'cid', clientSecret: 'secret' }) },
    { status: 200, json: async () => ({ deviceCode: 'd', userCode: 'U',
      verificationUri: 'https://view.awsapps.com/start/#/device', interval: 5, expiresIn: 600 }) },
    { status: 400, json: async () => ({ error: 'authorization_pending' }) },
    { status: 200, json: async () => ({ accessToken: 'aoa-device', refreshToken: 'aor-device', expiresIn: 3600 }) }
  ];
  let index = 0;
  const request = async () => sequence[index++];

  const registration = await registerKiroOidcClient({}, { request });
  const started = await startKiroDeviceAuthorization({ registration }, { request });
  assert.equal((await pollKiroDeviceToken({ registration, deviceCode: started.deviceCode }, { request })).status, 'pending');
  const polled = await pollKiroDeviceToken({ registration, deviceCode: started.deviceCode }, { request });
  assert.equal(polled.status, 'authorized');
  assert.equal(index, 4);

  // 凭据记录形态与 CLI 导入一致：registration（camelCase，normalizeRegistration 可直接消费）+ auth。
  const nativeAuth = {
    registration,
    auth: {
      access_token: polled.grant.accessToken,
      refresh_token: polled.grant.refreshToken,
      expires_at: new Date(polled.grant.expiresAtMs).toISOString(),
      region: polled.grant.region
    }
  };
  assert.equal(resolveKiroTokenFlavour(nativeAuth).flavour, KIRO_TOKEN_FLAVOURS.OIDC);

  // 同一个 registration 也能直接喂给刷新（证明三步之间没有隐藏状态）。
  const { refreshKiroGrant } = require('../lib/account/kiro-token-refresh');
  const refreshed = await refreshKiroGrant({ refreshToken: nativeAuth.auth.refresh_token, registration: {
    clientId: registration.clientId, clientSecret: registration.clientSecret, region: registration.region
  } }, { request: async () => ({ status: 200, json: async () => ({ accessToken: 'aoa-next', expiresIn: 60 }) }) });
  assert.equal(refreshed.accessToken, 'aoa-next');
});
