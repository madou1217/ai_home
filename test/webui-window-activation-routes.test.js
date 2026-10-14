'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { readWindowActivationConfig } = require('../lib/account/window-activation-store');
const {
  handleWindowActivationRequest,
  matchWindowActivationRoute,
  parseWindowActivationRoute
} = require('../lib/server/webui-window-activation-routes');

function createResponse() {
  return { statusCode: 0, payload: null };
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.payload = payload;
}

function createFixture(t, provider = 'codex') {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-window-activation-route-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider,
    cliAccountId: '1',
    identitySeed: `oauth:${provider}:window-activation-route@example.com`
  });
  return { accountRef, aiHomeDir, provider };
}

function createContext(fixture, method, payload, pathname) {
  return {
    pathname: pathname || `/v0/webui/accounts/${fixture.provider}/${fixture.accountRef}/window-activation`,
    req: { method },
    res: createResponse(),
    fs,
    aiHomeDir: fixture.aiHomeDir,
    readRequestBody: async () => payload,
    writeJson
  };
}

test('路由只匹配 GET/POST 并安全解析账号路径', () => {
  const pathname = '/v0/webui/accounts/codex/acct_91aa805bdd051b40fa47/window-activation';
  assert.equal(matchWindowActivationRoute('GET', pathname), true);
  assert.equal(matchWindowActivationRoute('POST', pathname), true);
  assert.equal(matchWindowActivationRoute('DELETE', pathname), false);
  assert.deepEqual(parseWindowActivationRoute(pathname), {
    provider: 'codex',
    accountRef: 'acct_91aa805bdd051b40fa47'
  });
  assert.equal(parseWindowActivationRoute('/v0/webui/accounts/codex/%E0%A4%A/window-activation'), null);
  assert.equal(matchWindowActivationRoute('GET', `${pathname}/extra`), false);
});

test('GET 未配置时返回关闭 + 跟随默认', async (t) => {
  const fixture = createFixture(t);
  const ctx = createContext(fixture, 'GET', null);
  await handleWindowActivationRequest(ctx);
  assert.equal(ctx.res.statusCode, 200);
  assert.deepEqual(ctx.res.payload.setting, { enabled: false, intervalMs: null });
});

test('POST 写入后 GET 返回同一设置', async (t) => {
  const fixture = createFixture(t);
  const post = createContext(fixture, 'POST', Buffer.from(JSON.stringify({ enabled: true, intervalMs: 7200000 })));
  await handleWindowActivationRequest(post);
  assert.equal(post.res.statusCode, 200);
  assert.deepEqual(post.res.payload.setting, { enabled: true, intervalMs: 7200000 });

  const get = createContext(fixture, 'GET', null);
  await handleWindowActivationRequest(get);
  assert.deepEqual(get.res.payload.setting, { enabled: true, intervalMs: 7200000 });
});

test('POST intervalMs 为 null 表示跟随默认', async (t) => {
  const fixture = createFixture(t);
  const ctx = createContext(fixture, 'POST', Buffer.from(JSON.stringify({ enabled: true, intervalMs: null })));
  await handleWindowActivationRequest(ctx);
  assert.equal(ctx.res.statusCode, 200);
  assert.equal(ctx.res.payload.setting.intervalMs, null);
});

test('POST 拒绝过小/非法 intervalMs', async (t) => {
  const fixture = createFixture(t);
  for (const value of [1, -5, 'abc', 0]) {
    const ctx = createContext(fixture, 'POST', Buffer.from(JSON.stringify({ enabled: true, intervalMs: value })));
    await handleWindowActivationRequest(ctx);
    assert.equal(ctx.res.statusCode, 400, String(value));
    assert.equal(ctx.res.payload.error, 'invalid_interval_ms', String(value));
  }
  assert.equal(readWindowActivationConfig(fs, fixture.aiHomeDir, fixture.accountRef), null);
});

test('POST 坏 JSON 返回 400', async (t) => {
  const fixture = createFixture(t);
  const ctx = createContext(fixture, 'POST', Buffer.from('{'));
  await handleWindowActivationRequest(ctx);
  assert.equal(ctx.res.statusCode, 400);
  assert.equal(ctx.res.payload.error, 'invalid_json_body');
});

test('不支持的 provider 返回 400', async (t) => {
  const fixture = createFixture(t, 'codex');
  const pathname = `/v0/webui/accounts/claude/${fixture.accountRef}/window-activation`;
  const ctx = createContext(fixture, 'GET', null, pathname);
  await handleWindowActivationRequest(ctx);
  assert.equal(ctx.res.statusCode, 400);
  assert.equal(ctx.res.payload.error, 'window_activation_unsupported_provider');
});

test('账号不存在返回 404', async (t) => {
  const fixture = createFixture(t);
  const missing = createContext(
    fixture,
    'GET',
    null,
    '/v0/webui/accounts/codex/acct_missing000000000000/window-activation'
  );
  await handleWindowActivationRequest(missing);
  assert.equal(missing.res.statusCode, 404);
  assert.equal(missing.res.payload.error, 'account_not_found');
});

test('读取异常返回稳定 500', async (t) => {
  const fixture = createFixture(t);
  const ctx = createContext(fixture, 'GET', null);
  ctx.deps = {
    readWindowActivationConfig() { throw new Error('sensitive path'); }
  };
  await handleWindowActivationRequest(ctx);
  assert.equal(ctx.res.statusCode, 500);
  assert.deepEqual(ctx.res.payload, { ok: false, error: 'window_activation_read_failed' });
});

test('写入异常返回稳定 500 且不暴露底层错误', async (t) => {
  const fixture = createFixture(t);
  const ctx = createContext(fixture, 'POST', Buffer.from(JSON.stringify({ enabled: true })));
  ctx.deps = {
    writeWindowActivationConfig() { throw new Error('/private/path/app-state.db permission denied'); }
  };
  await handleWindowActivationRequest(ctx);
  assert.equal(ctx.res.statusCode, 500);
  assert.deepEqual(ctx.res.payload, { ok: false, error: 'window_activation_write_failed' });
});
