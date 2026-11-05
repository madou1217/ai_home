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

test('家族四支共用同一份派生结果', () => {
  for (const providerID of ['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']) {
    const descriptor = require(path.join(DEFS_DIR, providerID + '.js'));
    assert.equal(descriptor.capabilities.quota.supported, false);
    assert.match(descriptor.capabilities.quota.reason, new RegExp(providerID));
  }
});
