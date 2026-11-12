'use strict';

// 跨端额度 source 契约：Go 写进 aih.db 的快照由 Node 原样读取，Node 的 trusted
// 校验按 source 字面量判真伪。两边漂移时快照会被静默丢弃，WebUI 表现为剩余额度
// Unknown（2026-11-05 zcode 事故：Go 写 zcode_plan_balance_api，Node 只认
// zcode_plan_billing_balance_api，8 个账号全部丢快照）。
//
// 这里直接读 Go 源码里的常量，任意一侧改动都会让测试变红。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { USAGE_SNAPSHOT_KINDS, USAGE_SOURCE_ZCODE } = require('../lib/account/usage-remaining');
const { readTrustedUsageSnapshot } = require('../lib/server/accounts');

const repoRoot = path.join(__dirname, '..');

function readGoSourceID(relativePath) {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  const match = source.match(/sourceID\s*=\s*"([^"]+)"/);
  assert.ok(match, relativePath + ' 里没有 sourceID 常量');
  return match[1];
}

test('zcode 的 source 字面量两侧一致', () => {
  assert.equal(
    readGoSourceID('internal/adapters/zcode/usage/strategy.go'),
    USAGE_SOURCE_ZCODE
  );
});

test('Go 形状的 zcode 快照能通过 Node 的可信校验', () => {
  const snapshot = {
    schemaVersion: 2,
    kind: USAGE_SNAPSHOT_KINDS.zcode,
    source: USAGE_SOURCE_ZCODE,
    capturedAt: 1793892753166,
    entries: [
      { bucket: 'glm-5.3-flash', remainingPct: 100, windowMinutes: 722, resetAtMs: 1793926800000 }
    ]
  };
  const trusted = readTrustedUsageSnapshot(
    { readUsageSnapshot: () => snapshot },
    'zcode',
    'acct_test'
  );
  assert.equal(trusted, snapshot);
});
