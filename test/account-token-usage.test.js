const test = require('node:test');
const assert = require('node:assert/strict');

const { applyAccountTokenUsageDelta } = require('../lib/usage/account-token-usage');

test('account token delta respects local windows without mutating cached usage', () => {
  const nowMs = new Date(2026, 8, 23, 12).getTime();
  const usage = {
    day: 10, week: 20, month: 30, total: 40,
    models: [{
      model: 'gpt-5', day: 10, week: 20, month: 30, total: 40,
      dayCostUsd: 1, weekCostUsd: 2, monthCostUsd: 3, totalCostUsd: 4
    }]
  };
  const event = {
    model: 'gpt-5', total: 5,
    occurredAt: new Date(2026, 8, 21, 10).getTime()
  };
  const next = applyAccountTokenUsageDelta(usage, event, nowMs);

  assert.deepEqual([next.day, next.week, next.month, next.total], [10, 25, 35, 45]);
  assert.deepEqual([
    next.models[0].day, next.models[0].week,
    next.models[0].month, next.models[0].total
  ], [10, 25, 35, 45]);
  assert.deepEqual([
    next.models[0].dayCostUsd, next.models[0].weekCostUsd,
    next.models[0].monthCostUsd, next.models[0].totalCostUsd
  ], [1, null, null, null]);
  assert.equal(usage.week, 20);
  assert.equal(usage.models[0].weekCostUsd, 2);
  assert.equal(applyAccountTokenUsageDelta(usage, { ...event, occurredAt: nowMs + 1 }, nowMs), usage);
});
