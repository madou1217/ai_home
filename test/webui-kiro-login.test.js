'use strict';

// WebUI 的 kiro 原生登录入口回归（设备码 start|poll + refresh_token 导入）。
//
// 两条硬约束：
//   ① **client_secret / deviceCode 绝不下发浏览器** —— start 的响应体里只能有用户需要看的东西；
//   ② 流程状态 fail closed —— 过期/未知 flowId 一律 404 让前端重新发起，不拿残缺状态去猜。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createKiroNativeLoginStore,
  handleKiroNativeLoginPollRequest,
  handleKiroNativeLoginStartRequest,
  handleKiroRefreshTokenImportRequest
} = require('../lib/server/webui-kiro-login');

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kiro-webui-'));
}

function makeCtx(options = {}) {
  const captured = { status: 0, payload: null };
  const ctx = {
    fs,
    req: {},
    res: {},
    options: { aiHomeDir: options.aiHomeDir || tempHome() },
    deps: options.deps || {},
    readRequestBody: async () => (options.body === undefined
      ? null
      : Buffer.from(JSON.stringify(options.body))),
    writeJson: (_res, status, payload) => {
      captured.status = status;
      captured.payload = payload;
    }
  };
  return { ctx, captured };
}

/** 按 URL 分派的假上游：注册 / 开始授权 / 换 token / GetUsageLimits。 */
function fakeUpstream(options = {}) {
  const calls = [];
  // token 分支的行为可切换：pending / 拒绝 / 成功由用例改 state.token（引用不变，避免闭包抓旧函数）。
  const state = { token: options.token || null };
  const request = async (url, init) => {
    const target = String(url);
    calls.push({ url: target, body: init && init.body ? JSON.parse(init.body) : null });
    if (target.includes('/client/register')) {
      return { status: 200, json: async () => ({ clientId: 'cid', clientSecret: 'secret' }) };
    }
    if (target.includes('/device_authorization')) {
      return { status: 200, json: async () => ({ deviceCode: 'device-code', userCode: 'CODE-1234',
        verificationUri: 'https://view.awsapps.com/start/#/device',
        verificationUriComplete: 'https://view.awsapps.com/start/#/device?user_code=CODE-1234',
        interval: 5, expiresIn: 600 }) };
    }
    if (target.includes('/token')) {
      if (state.token) return state.token;
      return { status: 200, json: async () => ({ accessToken: 'aoa-web', refreshToken: 'aor-web', expiresIn: 3600 }) };
    }
    if (target.includes('codewhisperer.')) {
      // 身份核验按 body 流读取，因此这里必须是真 Response（与线上 fetch 同形）。
      return new Response(JSON.stringify({
        userInfo: { userId: 'kiro-user', email: 'kiro@example.invalid' },
        subscriptionInfo: { type: 'Q_DEVELOPER_STANDALONE_FREE', subscriptionTitle: 'KIRO FREE' },
        usageBreakdownList: [{ resourceType: 'CREDIT', usageLimit: 50, currentUsageWithPrecision: 0.13,
          usageLimitWithPrecision: 50 }]
      }), { status: 200 });
    }
    throw new Error(`unexpected_url:${target}`);
  };
  return { request, calls, state };
}

test('start：只回用户要看的 code/URL，client_secret 与 deviceCode 绝不出服务端', async () => {
  const aiHomeDir = tempHome();
  try {
    const upstream = fakeUpstream();
    const { ctx, captured } = makeCtx({ aiHomeDir, deps: { fetchWithTimeout: upstream.request } });
    assert.equal(await handleKiroNativeLoginStartRequest(ctx), true);

    assert.equal(captured.status, 200);
    assert.equal(captured.payload.ok, true);
    assert.equal(captured.payload.userCode, 'CODE-1234');
    assert.equal(captured.payload.verificationUriComplete, 'https://view.awsapps.com/start/#/device?user_code=CODE-1234');
    assert.equal(captured.payload.intervalSeconds, 5);
    assert.ok(captured.payload.flowId);
    assert.ok(captured.payload.expiresAtMs > Date.now());

    const serialized = JSON.stringify(captured.payload);
    for (const secret of ['clientSecret', 'secret', 'deviceCode', 'registration']) {
      assert.equal(serialized.includes(secret), false, `响应体不得包含 ${secret}`);
    }
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('poll：pending 只是状态；授权成功后落库注册账号，且流程被消费（再次 poll 404）', async () => {
  const aiHomeDir = tempHome();
  try {
    const upstream = fakeUpstream();
    const registered = [];
    const deps = {
      fetchWithTimeout: upstream.request,
      // 注册替身：真实实现会写账号库，这里只证明「拿到正确入参」。
      registerKiroNativeLogin: async (targetFs, runtimeDir, options) => {
        registered.push({ runtimeDir, accountRef: options.accountRef,
          token: require('../lib/account/kiro-auth-metadata')
            .readKiroTokenFromDatabase(path.join(runtimeDir, 'data.sqlite3')) });
        return { registered: true, accountRef: 'acct_web', cliAccountId: '9' };
      }
    };
    const { ctx, captured } = makeCtx({ aiHomeDir, deps });
    await handleKiroNativeLoginStartRequest(ctx);
    const flowId = captured.payload.flowId;

    // 第一次 poll：用户还没批准 → pending（不是错误）。
    upstream.state.token = { status: 400, json: async () => ({ error: 'authorization_pending' }) };
    await handleKiroNativeLoginPollRequest({ ...ctx, readRequestBody: async () => Buffer.from(JSON.stringify({ flowId })) });
    assert.deepEqual(captured.payload, { ok: true, status: 'pending' });

    // 第二次 poll：已批准 → 注册账号。
    upstream.state.token = null;
    await handleKiroNativeLoginPollRequest({ ...ctx, readRequestBody: async () => Buffer.from(JSON.stringify({ flowId })) });
    assert.equal(captured.status, 200);
    assert.deepEqual(captured.payload, { ok: true, status: 'authorized', accountRef: 'acct_web', cliAccountId: '9' });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].token.access_token, 'aoa-web', '注册前凭据必须已落盘');

    // 流程已消费：再 poll 必须 404（不允许重放）。
    await handleKiroNativeLoginPollRequest({ ...ctx, readRequestBody: async () => Buffer.from(JSON.stringify({ flowId })) });
    assert.equal(captured.status, 404);
    assert.equal(captured.payload.error, 'login_flow_not_found');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('poll：未知/过期 flowId 一律 404 fail closed；缺 flowId 400', async () => {
  const { ctx, captured } = makeCtx({ deps: { fetchWithTimeout: fakeUpstream().request } });
  await handleKiroNativeLoginPollRequest({ ...ctx, readRequestBody: async () => Buffer.from('{}') });
  assert.equal(captured.status, 400);
  assert.equal(captured.payload.error, 'missing_flow_id');

  await handleKiroNativeLoginPollRequest({ ...ctx,
    readRequestBody: async () => Buffer.from(JSON.stringify({ flowId: 'nope' })) });
  assert.equal(captured.status, 404);

  // TTL 过期：注册表按注入时钟判定，过期即查不到。
  let clock = 1_000_000;
  const store = createKiroNativeLoginStore({ ttlMs: 1000, now: () => clock });
  const flowId = store.put({ runtimeDir: '/tmp/x', registration: {}, deviceCode: 'd', expiresAtMs: Date.now() + 1000 });
  assert.ok(store.get(flowId));
  clock += 1001;
  assert.equal(store.get(flowId), null);
});

test('poll：上游硬错误（clientSecret 失效）502 且流程作废；用户拒绝/过期回状态', async () => {
  const aiHomeDir = tempHome();
  try {
    const upstream = fakeUpstream();
    const { ctx, captured } = makeCtx({ aiHomeDir, deps: { fetchWithTimeout: upstream.request } });
    await handleKiroNativeLoginStartRequest(ctx);
    const flowId = captured.payload.flowId;

    upstream.state.token = { status: 401, json: async () => ({ error: 'invalid_client' }) };
    await handleKiroNativeLoginPollRequest({ ...ctx, readRequestBody: async () => Buffer.from(JSON.stringify({ flowId })) });
    assert.equal(captured.status, 502);
    assert.match(captured.payload.error, /device_login_poll_failed:kiro_device_invalid_client/);

    // 作废后不可重放。
    await handleKiroNativeLoginPollRequest({ ...ctx, readRequestBody: async () => Buffer.from(JSON.stringify({ flowId })) });
    assert.equal(captured.status, 404);

    // 用户点拒绝：状态回给前端，不是 5xx。
    const upstream2 = fakeUpstream({ token: { status: 400, json: async () => ({ error: 'access_denied' }) } });
    const second = makeCtx({ aiHomeDir, deps: { fetchWithTimeout: upstream2.request } });
    await handleKiroNativeLoginStartRequest(second.ctx);
    await handleKiroNativeLoginPollRequest({ ...second.ctx,
      readRequestBody: async () => Buffer.from(JSON.stringify({ flowId: second.captured.payload.flowId })) });
    assert.equal(second.captured.status, 200);
    assert.equal(second.captured.payload.status, 'denied');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('refresh_token 导入（B）：缺 token 400、上游拒绝 502、注册失败 409 且不谎报成功', async () => {
  const aiHomeDir = tempHome();
  try {
    const desktop = async () => ({ status: 200, json: async () => ({ accessToken: 'aoa-ide', expiresIn: 3600,
      profileArn: 'arn:profile/ide' }) });

    const missing = makeCtx({ aiHomeDir, body: {}, deps: { fetchWithTimeout: desktop } });
    await handleKiroRefreshTokenImportRequest(missing.ctx);
    assert.equal(missing.captured.status, 400);
    assert.equal(missing.captured.payload.error, 'missing_refresh_token');

    const ok = makeCtx({ aiHomeDir, body: { refreshToken: 'aor-ide' }, deps: {
      fetchWithTimeout: desktop,
      registerKiroNativeLogin: async () => ({ registered: true, accountRef: 'acct_ide', cliAccountId: '11' })
    } });
    await handleKiroRefreshTokenImportRequest(ok.ctx);
    assert.equal(ok.captured.status, 200);
    assert.deepEqual(ok.captured.payload, { ok: true, accountRef: 'acct_ide', cliAccountId: '11' });

    const rejected = makeCtx({ aiHomeDir, body: { refreshToken: 'aor-bad' }, deps: {
      fetchWithTimeout: async () => ({ status: 403, json: async () => ({}) })
    } });
    await handleKiroRefreshTokenImportRequest(rejected.ctx);
    assert.equal(rejected.captured.status, 502);
    assert.match(rejected.captured.payload.error, /kiro_desktop_refresh_unauthorized/);

    const conflicted = makeCtx({ aiHomeDir, body: { refreshToken: 'aor-ide' }, deps: {
      fetchWithTimeout: desktop,
      registerKiroNativeLogin: async () => ({ registered: false, reason: 'account_identity_mismatch' })
    } });
    await handleKiroRefreshTokenImportRequest(conflicted.ctx);
    assert.equal(conflicted.captured.status, 409);
    assert.equal(conflicted.captured.payload.error, 'account_identity_mismatch');
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('端到端（无 CLI）：start → poll → 真实注册链路把账号写进账号库', async () => {
  const aiHomeDir = tempHome();
  try {
    const upstream = fakeUpstream();
    const { ctx, captured } = makeCtx({ aiHomeDir, deps: { fetchWithTimeout: upstream.request } });
    await handleKiroNativeLoginStartRequest(ctx);
    await handleKiroNativeLoginPollRequest({ ...ctx,
      readRequestBody: async () => Buffer.from(JSON.stringify({ flowId: captured.payload.flowId })) });

    assert.equal(captured.status, 200);
    assert.equal(captured.payload.status, 'authorized');
    assert.match(captured.payload.accountRef, /^acct_/);

    // 真实注册链路（registerKiroNativeLogin，不注入替身）：账号与凭据都必须落库。
    const { readAccountCredentialRecord } = require('../lib/server/account-credential-store');
    const record = readAccountCredentialRecord(fs, aiHomeDir, captured.payload.accountRef);
    assert.equal(record.provider, 'kiro');
    assert.equal(record.nativeAuth.auth.access_token, 'aoa-web');
    assert.equal(record.nativeAuth.identityEvidence.subject, 'kiro-user');
    // device-registration 与 CLI 导入形态一致：写在投影 sqlite 的 auth_kv 里（nativeAuth.database），
    // 既有的解析器必须能读出来 —— 这是「下游一行未改」的证明。
    assert.ok(record.nativeAuth.database, '投影 sqlite 必须以 base64 落库');
    const resolved = require('../lib/account/kiro-device-registration')
      .resolveKiroDeviceRegistration(record.nativeAuth);
    assert.equal(resolved.registration.clientId, 'cid');
    assert.equal(resolved.registration.clientSecret, 'secret');
    // 判型为 oidc：下次刷新不必再猜口径。
    const { resolveKiroTokenFlavour, KIRO_TOKEN_FLAVOURS } = require('../lib/account/kiro-token-flavour');
    assert.equal(resolveKiroTokenFlavour(record.nativeAuth).flavour, KIRO_TOKEN_FLAVOURS.OIDC);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});
