'use strict';

// 回归守卫：BigModel 编程套餐额度（5h / 每周 / ZCode MCP）必须进入 WebUI 快照。
//
// 2026-11-04 真机：桌面端「智谱 → BigModel」页显示 GLM Coding Plan 的 5 小时/每周/MCP
// 额度，WebUI 只显示 ZCode 计划（billing/balance），因为探针没调用 BigModel 的
// /api/monitor/usage/quota/limit 与 /api/v1/mcp/usage。这里锁住映射与合并。

const test = require('node:test');
const assert = require('node:assert');
const { __private } = require('../lib/cli/services/usage/zcode-quota-probe');

const { buildCodingPlanEntries, buildMcpUsageEntry, mergeCodingPlanIntoSnapshot } = __private;

test('BigModel quota limits → 5h/每周条目（percentage 是已用百分比）', () => {
  const entries = buildCodingPlanEntries({
    code: 200,
    data: {
      level: 'lite',
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 5000, currentValue: 1250, remaining: 3750, percentage: 25 },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 5000, currentValue: 0, remaining: 5000, percentage: 0, nextResetTime: 1794313081999 }
      ]
    }
  }, Date.now());
  assert.equal(entries.length, 2);
  assert.equal(entries[0].label, '5h 剩余');
  assert.equal(entries[0].windowMinutes, 300);
  assert.equal(entries[0].remainingPct, 75);
  assert.equal(entries[0].remainingUnits, 3750);
  assert.equal(entries[1].label, '每周剩余');
  assert.equal(entries[1].windowMinutes, 10080);
  assert.equal(entries[1].remainingPct, 100);
});

test('ZCode MCP usage → 100% 条目', () => {
  const entry = buildMcpUsageEntry({
    code: 0,
    data: { next_refresh_at: 1793808000, level: 'lite', total_usage: { used: 10, limit: 1000, remaining: 990 } }
  }, Date.now());
  assert.ok(entry);
  assert.equal(entry.label, 'ZCode MCP');
  assert.equal(entry.remainingPct, 99);
  assert.equal(entry.totalUnits, 1000);
  assert.equal(entry.remainingUnits, 990);
});

test('合并且不破坏已有 ZCode 计划分组', () => {
  const snapshot = {
    kind: 'zcode_plan_balance',
    capturedAt: 1,
    entries: [{ bucket: 'glm-5.3-flash', remainingPct: 100 }],
    planGroups: [{ planGroupId: 'upl_1', planId: 'zcode-v3-start-plan-1103', name: 'ZCODE GLOBAL BUILD', entries: [] }],
    account: { planType: 'ZCODE GLOBAL BUILD', planNames: ['ZCODE GLOBAL BUILD'] }
  };
  const codingPlan = {
    entries: [
      { bucket: 'coding_plan_5h', remainingPct: 100 },
      { bucket: 'coding_plan_weekly', remainingPct: 100 },
      { bucket: 'zcode_mcp', remainingPct: 100 }
    ]
  };
  mergeCodingPlanIntoSnapshot(snapshot, codingPlan);
  assert.equal(snapshot.entries.length, 4);
  assert.equal(snapshot.planGroups.length, 2);
  assert.equal(snapshot.planGroups[1].name, 'GLM Coding Plan');
  assert.deepEqual(snapshot.account.planNames, ['ZCODE GLOBAL BUILD', 'GLM Coding Plan']);
  assert.equal(snapshot.account.planType, 'ZCODE GLOBAL BUILD');
});

test('没有 ZCode 计划时，编程套餐单独成快照（不判无套餐）', () => {
  const snapshot = { kind: 'zcode_plan_balance', capturedAt: 1, entries: [] };
  mergeCodingPlanIntoSnapshot(snapshot, { entries: [{ bucket: 'coding_plan_5h', remainingPct: 100 }] });
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.account.planType, 'GLM Coding Plan');
});

