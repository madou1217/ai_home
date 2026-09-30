'use strict';

// 回归:长期运行的终端会话用旧代码每分钟写一次额度快照(不带套餐确认时间),把新代码
// 刚记下的确认冲掉,账号页一直显示「订阅已到期,待确认」,点确认也只闪一下。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { readAccountUsageSnapshot, writeAccountUsageSnapshot } = require('../lib/account/usage-snapshot-store');

function snapshot(planType, capturedAt, planConfirmedAtMs) {
  return {
    schemaVersion: 2,
    kind: 'codex_oauth_status',
    source: 'codex_app_server',
    capturedAt,
    account: { planType, subscriptionActiveUntilMs: 1_000, ...(planConfirmedAtMs ? { planConfirmedAtMs } : {}) },
    entries: []
  };
}

test('套餐确认不会被旧格式快照覆盖掉,套餐变化后不再作数', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-plan-confirmation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountRef = upsertAccountRef(fs, root, { provider: 'codex', cliAccountId: '31', identitySeed: 'oauth:codex:plan-confirm-user' });

  writeAccountUsageSnapshot(fs, root, accountRef, snapshot('prolite', 2_000, 2_000));
  // 旧进程随后写入的快照:同一套餐,但没有确认时间
  writeAccountUsageSnapshot(fs, root, accountRef, snapshot('prolite', 3_000, 0));
  assert.equal(readAccountUsageSnapshot(fs, root, accountRef).account.planConfirmedAtMs, 2_000);

  // 套餐变了(例如降为 free):旧确认不能证明新套餐
  writeAccountUsageSnapshot(fs, root, accountRef, snapshot('free', 4_000, 0));
  assert.equal(readAccountUsageSnapshot(fs, root, accountRef).account.planConfirmedAtMs, undefined);
});
