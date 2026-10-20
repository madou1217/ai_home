'use strict';

// 别名请求把「不入别名池」的账号摘掉后，错误必须可归因：
// 全部账号都退出时返回 alias_pool_exhausted，而不是笼统的 no_available_account。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  selectAccountsForRequestModel,
  writeNoModelAccountResponse
} = require('../lib/server/upstream-endpoints-failure');

const ENTER = 'acct_1111111111111111bbbb';
const OPT_OUT = 'acct_2222222222222222cccc';
const MODEL = 'gpt-5.6-luna';

function account(accountRef, participates) {
  return {
    accountRef,
    accessToken: 'token',
    apiKeyMode: true,
    schedulableStatus: 'schedulable',
    ...(participates === false ? { aliasPoolParticipates: false } : {})
  };
}

function makeState(byAccount) {
  return {
    webUiModelsCache: {
      updatedAt: Date.now(),
      byAccount,
      byProvider: {}
    }
  };
}

test('别名请求按账号开关收窄；非别名请求保持整池', () => {
  const pool = [account(ENTER, true), account(OPT_OUT, false)];
  const state = makeState({
    [ENTER]: [MODEL],
    [OPT_OUT]: [MODEL]
  });
  const requestJson = { model: MODEL, input: 'hi' };

  const alias = selectAccountsForRequestModel(
    pool, 'codex', requestJson, state, {}, { aliasMatched: true }
  );
  assert.deepEqual(alias.pool.map((item) => item.accountRef), [ENTER]);
  assert.deepEqual(alias.aliasPoolExcludedAccountRefs, [OPT_OUT]);

  const normal = selectAccountsForRequestModel(
    pool, 'codex', requestJson, state, {}, { aliasMatched: false }
  );
  assert.deepEqual(normal.pool.map((item) => item.accountRef).sort(), [ENTER, OPT_OUT].sort());

  // 显式钉选的单账号池没有 requestContext，退出别名池不影响它。
  const pinned = selectAccountsForRequestModel(
    [pool[1]], 'codex', requestJson, state, {}, null
  );
  assert.equal(pinned.pool.length, 1);
});

test('全部账号退出别名池时标记 aliasPoolExhausted', () => {
  const pool = [account(OPT_OUT, false)];
  const state = makeState({ [OPT_OUT]: [MODEL] });
  const selection = selectAccountsForRequestModel(
    pool, 'codex', { model: MODEL, input: 'hi' }, state, {}, { aliasMatched: true }
  );
  assert.deepEqual(selection.pool, []);
  assert.equal(selection.aliasPoolExhausted, true);
});

test('writeNoModelAccountResponse 对别名池散尽给出专属错误码', () => {
  const written = [];
  const metricsErrors = [];
  const state = { metrics: { totalFailures: 0, providerFailures: {}, errors: [] } };
  const input = {
    writeJson: (res, statusCode, payload) => written.push({ statusCode, payload }),
    res: {},
    provider: 'codex',
    routeKey: 'POST /v1/responses',
    state,
    pushMetricError: (_metrics, _routeKey, _provider, entry) => metricsErrors.push(entry),
    requestMeta: { requestId: 'req-1' },
    requestStartedAt: Date.now(),
    streamRequested: false,
    streamTransport: 'http',
    selectedPool: [account(OPT_OUT, false)],
    model: MODEL,
    options: {}
  };

  writeNoModelAccountResponse({ ...input, aliasPoolExhausted: true });
  assert.equal(written[0].statusCode, 503);
  assert.equal(written[0].payload.error, 'alias_pool_exhausted');
  assert.equal(written[0].payload.availability.reason, 'alias_pool_exhausted');
  assert.match(written[0].payload.detail, /opted out of alias routing/);
  assert.equal(metricsErrors[0].error, 'alias_pool_exhausted');

  // 默认路径不受影响。
  writeNoModelAccountResponse({ ...input, aliasPoolExhausted: false });
  assert.equal(written[1].payload.error, 'no_available_account');
  assert.equal(written[1].payload.availability.reason, 'no_eligible_account');
});
