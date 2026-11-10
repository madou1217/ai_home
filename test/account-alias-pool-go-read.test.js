'use strict';

// 别名自动选号池：GET/POST 都固定走 Go；Node 只在写成功后重载运行池。
// 这组用例锁住切流边界：不回落本地写路径。

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleAliasPoolRequest } = require('../lib/server/webui-alias-pool-routes');

const PROVIDER = 'claude';
const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const PATHNAME = `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/alias-pool`;

function createCtx(options = {}) {
  const captured = { status: 0, body: null };
  const calls = [];
  return {
    captured,
    calls,
    ctx: {
      pathname: PATHNAME,
      req: { method: options.method || 'GET' },
      res: {},
      deps: options.goHost === null ? {} : {
        goCoreSync: {
          getAccountAliasPool: async (...args) => {
            calls.push(args);
            if (options.throws) throw new Error('go core exploded');
            return options.result;
          },
          setAccountAliasPool: async (...args) => {
            calls.push(args);
            if (options.throws) throw new Error('go core exploded');
            return options.result;
          }
        }
      },
      aiHomeDir: options.aiHomeDir || '',
      readRequestBody: async () => Buffer.from(options.body === undefined ? '{"participates":true}' : options.body, 'utf8'),
      writeJson: (res, status, body) => { captured.status = status; captured.body = body; }
    }
  };
}

const goSuccess = {
  ok: true,
  status: 200,
  data: { ok: true, provider: PROVIDER, accountRef: ACCOUNT_REF, setting: { participates: false } }
};

test('alias-pool GET：固定读 Go 并原样返回设置', async () => {
  const { ctx, captured, calls } = createCtx({ result: goSuccess });
  assert.equal(await handleAliasPoolRequest(ctx), true);
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, goSuccess.data);
  assert.deepEqual(calls[0], [PROVIDER, ACCOUNT_REF]);
});

test('alias-pool GET：Go 的 409 冲突原样透传', async () => {
  const { ctx, captured } = createCtx({
    result: { ok: false, status: 409, data: { ok: false, error: 'account_provider_mismatch' } }
  });
  await handleAliasPoolRequest(ctx);
  assert.equal(captured.status, 409);
  assert.equal(captured.body.error, 'account_provider_mismatch');
});

test('alias-pool GET：Go 门面缺失时 503，没有本地回退', async () => {
  const { ctx, captured } = createCtx({ goHost: null });
  await handleAliasPoolRequest(ctx);
  assert.equal(captured.status, 503);
  assert.equal(captured.body.error, 'go_core_unavailable');
});

test('alias-pool GET：Go 抛错时 503', async () => {
  const { ctx, captured } = createCtx({ throws: true });
  await handleAliasPoolRequest(ctx);
  assert.equal(captured.status, 503);
});

test('alias-pool POST：固定写 Go，Node 只补 reloaded', async () => {
  const { ctx, captured, calls } = createCtx({ method: 'POST', body: '{"participates":false}', result: goSuccess });
  await handleAliasPoolRequest(ctx);
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, { ...goSuccess.data, reloaded: false });
  assert.deepEqual(calls[0], [PROVIDER, ACCOUNT_REF, false]);
});

test('alias-pool POST：非法 participates 400，不调用 Go', async () => {
  const { ctx, captured, calls } = createCtx({ method: 'POST', body: '{"participates":"yes"}', result: goSuccess });
  await handleAliasPoolRequest(ctx);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.error, 'invalid_participates');
  assert.equal(calls.length, 0);
});

test('alias-pool POST：Go 的 409 冲突原样透传', async () => {
  const { ctx, captured } = createCtx({
    method: 'POST',
    result: { ok: false, status: 409, data: { ok: false, error: 'account_provider_mismatch' } }
  });
  await handleAliasPoolRequest(ctx);
  assert.equal(captured.status, 409);
  assert.equal(captured.body.error, 'account_provider_mismatch');
});

test('alias-pool POST：Go 不可用时 503，没有本地回退', async () => {
  const { ctx, captured } = createCtx({ method: 'POST', goHost: null });
  await handleAliasPoolRequest(ctx);
  assert.equal(captured.status, 503);
  assert.equal(captured.body.error, 'go_core_unavailable');
});
