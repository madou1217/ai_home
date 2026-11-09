'use strict';

// 别名自动选号池：GET 固定读 Go，POST 仍走 Node 写路径。
// 这组用例锁住切流边界：GET 不回落本地，POST 不误调用 Go。

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
          }
        }
      },
      aiHomeDir: options.aiHomeDir || '',
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

test('alias-pool POST：不调用 Go，仍走本地写路径', async () => {
  const { ctx, captured, calls } = createCtx({ method: 'POST', result: goSuccess });
  await handleAliasPoolRequest(ctx);
  // 没有 aiHomeDir：本地写路径在读取数据根时失败，证明没有走 Go。
  assert.equal(captured.status, 503);
  assert.equal(captured.body.error, 'ai_home_dir_unavailable');
  assert.equal(calls.length, 0);
});
