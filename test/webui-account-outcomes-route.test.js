'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { handleWebUiAccountOutcomesRoute } = require('../lib/server/webui-account-outcomes-route');
const { localDayStart, localHourStart } = require('../lib/server/node-account-outcomes');

function createCtx(deps, state) {
  const out = {};
  return {
    ctx: {
      method: 'GET',
      pathname: '/v0/webui/account-outcomes',
      state: state || { accounts: {} },
      deps,
      res: {},
      writeJson: (_res, status, payload) => {
        out.status = status;
        out.payload = payload;
      }
    },
    out
  };
}

test('account outcomes route merges Node-served buckets into the Go view', async () => {
  const nowMs = Date.now();
  const dayStart = localDayStart(nowMs);
  const hourStart = localHourStart(nowMs);
  const { ctx, out } = createCtx({
    listGoAccountOutcomes: (granularity) => (granularity === 'day'
      ? [{ account_ref: 'acct_go_codex', bucket_start_ms: dayStart, outcome: 'success', count: 3 }]
      : [{ account_ref: 'acct_go_codex', bucket_start_ms: hourStart, outcome: 'success', count: 3 }]),
    listNodeAccountOutcomes: (granularity) => (granularity === 'day'
      ? [{ account_ref: 'acct_node_codex', bucket_start_ms: dayStart, outcome: 'rate_limited', count: 2 }]
      : [{ account_ref: 'acct_node_codex', bucket_start_ms: hourStart, outcome: 'rate_limited', count: 2 }]),
    goAccountRefFor: (ref) => (ref === 'acct_node_codex' ? 'acct_go_codex' : '')
  }, { accounts: { codex: [{ accountRef: 'acct_node_codex' }] } });

  assert.equal(await handleWebUiAccountOutcomesRoute(ctx), true);
  assert.equal(out.status, 200);
  const account = out.payload.data.accounts[0];
  assert.equal(account.accountRef, 'acct_node_codex');
  assert.deepEqual(account.days, [{ startMs: dayStart, success: 3, failures: { rate_limited: 2 } }],
    'Go successes and Node-served failures land in the same bucket');
  assert.deepEqual(account.hours, [{ startMs: hourStart, success: 3, failures: { rate_limited: 2 } }]);
});

test('account outcomes route stays Go-only when no Node-side source is wired', async () => {
  const nowMs = Date.now();
  const dayStart = localDayStart(nowMs);
  const { ctx, out } = createCtx({
    listGoAccountOutcomes: (granularity) => (granularity === 'day'
      ? [{ account_ref: 'acct_node_codex', bucket_start_ms: dayStart, outcome: 'success', count: 1 }]
      : []),
    goAccountRefFor: (ref) => ref
  }, { accounts: { codex: [{ accountRef: 'acct_node_codex' }] } });

  assert.equal(await handleWebUiAccountOutcomesRoute(ctx), true);
  assert.equal(out.status, 200);
  assert.deepEqual(out.payload.data.accounts[0].days, [{ startMs: dayStart, success: 1, failures: {} }]);
});

test('account outcomes route reports 503 when the Go source is unavailable', async () => {
  const { ctx, out } = createCtx({});
  assert.equal(await handleWebUiAccountOutcomesRoute(ctx), true);
  assert.equal(out.status, 503);
  assert.deepEqual(out.payload, { ok: false, error: 'account_outcomes_unavailable' });
});
