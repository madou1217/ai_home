'use strict';

// 额度归属的双向守卫：GO_QUOTA_OWNERS ↔ 各 Provider 描述符。
//
// 迁移期最容易出的错是「Go 已经在采、Node 还在探」或反过来。之前靠逐文件手改
// quota.supported，一天内改了 8 次；这张表让归属只有一个真值源，这个用例负责：
//   1) 表里登记的 Provider，descriptor 必须 supported:false 且 reason 指向 Go；
//   2) descriptor 里任何 supported:false 都必须在表里登记（禁止手写 false 绕过表）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GO_QUOTA_OWNERS, goOwnedQuota, isGoOwnedQuota } = require('../lib/providers/quota-ownership');
const { hasQuotaProvider, listQuotaSnapshotProviders, resolveEntryShapeByKind } = require('../lib/usage/quota');
const { normalizeAccountUsageSnapshot } = require('../lib/server/account-usage-view');
const { getMinRemainingPctFromUsageSnapshot } = require('../lib/account/usage-remaining');

const DEFS_DIR = path.join(__dirname, '..', 'lib', 'providers', 'defs');

function loadDescriptors() {
  const descriptors = new Map();
  for (const name of fs.readdirSync(DEFS_DIR)) {
    if (!name.endsWith('.js')) continue;
    const descriptor = require(path.join(DEFS_DIR, name));
    if (!descriptor || typeof descriptor !== 'object' || !descriptor.id) continue;
    descriptors.set(descriptor.id, descriptor);
  }
  return descriptors;
}

test('Go 已接管的 Provider：descriptor 必须 supported:false 且 reason 指向 Go', () => {
  const descriptors = loadDescriptors();
  for (const providerID of Object.keys(GO_QUOTA_OWNERS)) {
    const descriptor = descriptors.get(providerID);
    assert.ok(descriptor, '缺少 descriptor: ' + providerID);
    const quota = descriptor.capabilities.quota;
    assert.equal(quota.supported, false, providerID + ' 应声明 supported:false');
    assert.match(quota.reason, /Go 采集/, providerID + ' 的 reason 必须说明由 Go 采集');
  }
});

test('反向守卫：声称「由 Go 采集」的 descriptor 必须登记在表里', () => {
  const descriptors = loadDescriptors();
  for (const [providerID, descriptor] of descriptors) {
    const quota = descriptor.capabilities.quota;
    if (quota.supported !== false) continue;
    // supported:false 有两种语义：Go 已接管，或上游根本没有额度接口（如 opencode）。
    // 只有前者必须进表；两者都要求 reason 讲清楚，所以先卡 reason 再卡归属。
    assert.ok(String(quota.reason || '').trim(), providerID + ' 的 supported:false 必须给出 reason');
    if (!/Go 采集/.test(quota.reason)) continue;
    assert.ok(
      isGoOwnedQuota(providerID),
      providerID + ' 声称由 Go 采集但不在 GO_QUOTA_OWNERS 里——请登记归属，不要手写'
    );
  }
});

test('goOwnedQuota 对未登记 Provider 直接抛错', () => {
  assert.throws(() => goOwnedQuota('codex'), /不是 Go 采集/);
  assert.equal(isGoOwnedQuota('codex'), false);
  assert.equal(isGoOwnedQuota('CODEX'), false);
  assert.equal(isGoOwnedQuota('kiro'), true);
});

// 迁移只改 supported:false 会把 kind/entryShape 丢掉，WebUI 账号列表的剩余额度
// 整列变成 Unknown（2026-11-05 实测 13 个 Go 采集的 Provider 全部中招）。
// 这条守卫把「归属」和「展示契约」绑在一起：登记进表的 Provider 必须能被渲染。
test('Go 接管的 Provider 必须保留展示契约，且能被 WebUI 反查', () => {
  const snapshotProviders = new Set(listQuotaSnapshotProviders());
  const seenKinds = new Set();
  for (const providerID of Object.keys(GO_QUOTA_OWNERS)) {
    const quota = goOwnedQuota(providerID);
    assert.ok(quota.kind, providerID + ' 缺少快照 kind，Node 无法渲染 Go 产出的额度');
    assert.ok(quota.shape, providerID + ' 缺少 shape');
    assert.ok(quota.entryShape, providerID + ' 缺少 entryShape');
    assert.equal(
      resolveEntryShapeByKind(quota.kind),
      quota.entryShape,
      providerID + ' 的 kind 没有被 kind→entryShape 索引收录'
    );
    assert.ok(
      snapshotProviders.has(providerID),
      providerID + ' 不在 listQuotaSnapshotProviders() 里，账号页不会读它的快照'
    );
    assert.equal(
      hasQuotaProvider(providerID),
      true,
      providerID + ' 的 hasQuotaProvider() 仍为 false，deriveQuotaState 会把额度判成 not_applicable'
    );

    if (seenKinds.has(quota.kind)) continue;
    seenKinds.add(quota.kind);
    const snapshot = quota.entryShape === 'models'
      ? {
          schemaVersion: 2,
          kind: quota.kind,
          capturedAt: Date.now(),
          models: [{ model: 'fixture-model', remainingPct: 42 }]
        }
      : {
          schemaVersion: 2,
          kind: quota.kind,
          capturedAt: Date.now(),
          entries: [{ bucket: 'fixture-bucket', remainingPct: 42, windowMinutes: 300 }]
        };
    const normalized = normalizeAccountUsageSnapshot(snapshot);
    assert.ok(normalized, providerID + ' 的 Go 形状快照被 WebUI payload 丢弃');
    assert.equal(normalized.kind, quota.kind);
    assert.equal(getMinRemainingPctFromUsageSnapshot(normalized), 42);
  }
});

test('家族四支共用同一份派生结果', () => {
  for (const providerID of ['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']) {
    const descriptor = require(path.join(DEFS_DIR, providerID + '.js'));
    assert.equal(descriptor.capabilities.quota.supported, false);
    assert.match(descriptor.capabilities.quota.reason, new RegExp(providerID));
  }
});
