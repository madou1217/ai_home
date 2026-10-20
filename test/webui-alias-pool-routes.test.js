'use strict';

// WebUI 「别名选号」开关路由：读默认值、写入后立即重载运行池、账号/Provider 边界。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  handleAliasPoolRequest,
  matchAliasPoolRoute,
  parseAliasPoolRoute,
  presentSetting
} = require('../lib/server/webui-alias-pool-routes');
const { readAliasPoolConfig } = require('../lib/account/alias-pool-store');
const { upsertAccountRef } = require('../lib/server/account-ref-store');

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-alias-pool-route-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '7',
    identitySeed: 'oauth:codex:alias-pool-route@example.com'
  });
  const otherRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'agy',
    cliAccountId: '2',
    identitySeed: 'oauth:agy:alias-pool-route@example.com'
  });
  return { aiHomeDir, accountRef, otherRef };
}

function createCtx({ aiHomeDir, method, accountRef, provider = 'codex', body, extra = {} }) {
  const req = {
    method,
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  };
  const res = { statusCode: 0, payload: null };
  return {
    req,
    res,
    fs,
    aiHomeDir,
    pathname: `/v0/webui/accounts/${provider}/${accountRef}/alias-pool`,
    writeJson(target, statusCode, payload) {
      target.statusCode = statusCode;
      target.payload = payload;
    },
    async readRequestBody() {
      return req.body;
    },
    ...extra
  };
}

test('路由解析与匹配只认 alias-pool 子路径', () => {
  assert.deepEqual(
    parseAliasPoolRoute('/v0/webui/accounts/codex/acct_1111111111111111aaaa/alias-pool'),
    { provider: 'codex', accountRef: 'acct_1111111111111111aaaa' }
  );
  assert.equal(parseAliasPoolRoute('/v0/webui/accounts/codex/acct_1111111111111111aaaa/update'), null);
  assert.equal(matchAliasPoolRoute('GET', '/v0/webui/accounts/codex/acct_1111111111111111aaaa/alias-pool'), true);
  assert.equal(matchAliasPoolRoute('POST', '/v0/webui/accounts/codex/acct_1111111111111111aaaa/alias-pool'), true);
  assert.equal(matchAliasPoolRoute('DELETE', '/v0/webui/accounts/codex/acct_1111111111111111aaaa/alias-pool'), false);
});

test('没有记录时 GET 返回默认参与', async (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  const ctx = createCtx({ aiHomeDir, method: 'GET', accountRef });
  assert.equal(await handleAliasPoolRequest(ctx), true);
  assert.equal(ctx.res.statusCode, 200);
  assert.deepEqual(ctx.res.payload, {
    ok: true,
    provider: 'codex',
    accountRef,
    setting: { participates: true }
  });
});

test('POST 写入后 GET 读到退出状态，并触发运行池重载', async (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  const reloadCalls = [];
  const extra = {
    deps: { aiHomeDir },
    loadServerRuntimeAccounts() {
      reloadCalls.push('load');
      return { codex: [] };
    },
    applyReloadState(state, accounts) {
      state.reloadedAccounts = accounts;
    },
    state: {}
  };
  const post = createCtx({
    aiHomeDir,
    method: 'POST',
    accountRef,
    body: { participates: false },
    extra
  });
  assert.equal(await handleAliasPoolRequest(post), true);
  assert.equal(post.res.statusCode, 200);
  assert.equal(post.res.payload.setting.participates, false);
  assert.equal(post.res.payload.reloaded, true);
  assert.deepEqual(reloadCalls, ['load']);
  assert.deepEqual(post.state.reloadedAccounts, { codex: [] });
  assert.equal(readAliasPoolConfig(fs, aiHomeDir, accountRef).participates, false);

  const get = createCtx({ aiHomeDir, method: 'GET', accountRef });
  await handleAliasPoolRequest(get);
  assert.deepEqual(get.res.payload.setting, { participates: false });
});

test('写入 true 恢复参与，删除记录不影响显式钉选语义', async (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  const first = createCtx({
    aiHomeDir, method: 'POST', accountRef, body: { participates: false }
  });
  await handleAliasPoolRequest(first);
  const second = createCtx({
    aiHomeDir, method: 'POST', accountRef, body: { participates: true }
  });
  await handleAliasPoolRequest(second);
  assert.equal(second.res.payload.setting.participates, true);
  assert.equal(readAliasPoolConfig(fs, aiHomeDir, accountRef).participates, true);
});

test('账号不存在返回 404，Provider 不匹配返回 409', async (t) => {
  const { aiHomeDir, accountRef, otherRef } = createFixture(t);
  const missing = createCtx({
    aiHomeDir, method: 'GET', accountRef: 'acct_ffffffffffffffffffff'
  });
  await handleAliasPoolRequest(missing);
  assert.equal(missing.res.statusCode, 404);
  assert.equal(missing.res.payload.error, 'account_not_found');

  const mismatch = createCtx({
    aiHomeDir, method: 'GET', accountRef: otherRef, provider: 'codex'
  });
  await handleAliasPoolRequest(mismatch);
  assert.equal(mismatch.res.statusCode, 409);
  assert.equal(mismatch.res.payload.error, 'account_provider_mismatch');

  // 正确 provider 可读。
  const ok = createCtx({ aiHomeDir, method: 'GET', accountRef: otherRef, provider: 'agy' });
  await handleAliasPoolRequest(ok);
  assert.equal(ok.res.statusCode, 200);
});

test('POST 校验请求体与字段类型', async (t) => {
  const { aiHomeDir, accountRef } = createFixture(t);
  const invalidJson = createCtx({ aiHomeDir, method: 'POST', accountRef });
  invalidJson.readRequestBody = async () => Buffer.from('{');
  await handleAliasPoolRequest(invalidJson);
  assert.equal(invalidJson.res.statusCode, 400);
  assert.equal(invalidJson.res.payload.error, 'invalid_json_body');

  for (const body of [[], { participates: 'no' }, { participates: 1 }]) {
    const ctx = createCtx({ aiHomeDir, method: 'POST', accountRef, body });
    await handleAliasPoolRequest(ctx);
    assert.equal(ctx.res.statusCode, 400);
    assert.ok(['invalid_request_body', 'invalid_participates'].includes(ctx.res.payload.error));
  }
  assert.equal(readAliasPoolConfig(fs, aiHomeDir, accountRef), null);
});

test('presentSetting 对缺失记录按参与处理', () => {
  assert.deepEqual(presentSetting(null), { participates: true });
  assert.deepEqual(presentSetting({ participates: false }), { participates: false });
  assert.deepEqual(presentSetting({ participates: true }), { participates: true });
});
