'use strict';

// 账号额度重置历史 GET 固定读 Go：Node 不再自己查 app-state.db。
// 锁三件事：成功透传 Go 的响应、Go 的 400/404 领域错误原样透传、Go 不可用即 503。

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleWebUiAccountQuotaResetRoutes } = require('../lib/server/webui-account-quota-reset-routes');

const PROVIDER = 'claude';
const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const PATHNAME = `/v0/webui/accounts/${PROVIDER}/${ACCOUNT_REF}/quota-reset-events`;

function createCtx(options = {}) {
  const captured = { status: 0, body: null };
  const calls = [];
  const url = new URL('http://127.0.0.1' + PATHNAME + (options.search || ''));
  return {
    captured,
    calls,
    ctx: {
      method: options.method || 'GET',
      pathname: PATHNAME,
      url,
      res: {},
      deps: {
        ...(options.goHost === null ? {} : {
          goCoreSync: {
            getAccountQuotaResetEvents: async (...args) => {
              calls.push(args);
              if (options.throws) throw new Error('go core exploded');
              return options.result;
            }
          }
        })
      },
      writeJson: (res, status, body) => { captured.status = status; captured.body = body; }
    }
  };
}

const goSuccess = {
  ok: true,
  status: 200,
  data: {
    ok: true,
    provider: PROVIDER,
    accountRef: ACCOUNT_REF,
    events: [{ id: 7, eventKey: 'k', quotaKey: 'five_hour', occurredAtMs: 1000 }]
  }
};

test('quota-reset-events：成功时透传 Go 的响应与分页参数', async () => {
  const { ctx, captured, calls } = createCtx({ result: goSuccess, search: '?limit=2&beforeId=9' });
  assert.equal(await handleWebUiAccountQuotaResetRoutes(ctx), true);
  assert.equal(captured.status, 200);
  assert.deepEqual(captured.body, goSuccess.data);
  assert.deepEqual(calls[0], [PROVIDER, ACCOUNT_REF, { limit: 2, beforeId: 9 }]);
});

test('quota-reset-events：Go 的 404 领域错误原样透传', async () => {
  const { ctx, captured } = createCtx({
    result: { ok: false, status: 404, data: { ok: false, error: 'account_not_found', message: '未找到' } }
  });
  await handleWebUiAccountQuotaResetRoutes(ctx);
  assert.equal(captured.status, 404);
  assert.equal(captured.body.error, 'account_not_found');
});

test('quota-reset-events：Go 门面缺失时 503，没有本地回退', async () => {
  const { ctx, captured } = createCtx({ goHost: null });
  await handleWebUiAccountQuotaResetRoutes(ctx);
  assert.equal(captured.status, 503);
  assert.equal(captured.body.error, 'go_core_unavailable');
});

test('quota-reset-events：Go 抛错时 503', async () => {
  const { ctx, captured } = createCtx({ throws: true });
  await handleWebUiAccountQuotaResetRoutes(ctx);
  assert.equal(captured.status, 503);
});

test('quota-reset-events：非 GET 仍返回 405 且不调用 Go', async () => {
  const { ctx, captured, calls } = createCtx({ method: 'POST', result: goSuccess });
  await handleWebUiAccountQuotaResetRoutes(ctx);
  assert.equal(captured.status, 405);
  assert.equal(calls.length, 0);
});
