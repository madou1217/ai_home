'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { PROVIDER_IDS } = require('../lib/provider-catalog');
const { USAGE_MODULES, getProviderUsageStrategy } = require('../lib/usage/provider-usage');
const { USAGE_SNAPSHOT_KINDS } = require('../lib/account/usage-remaining');

test('用量端口：模块契约齐全，快照 kind 取自现有的 USAGE_SNAPSHOT_KINDS', () => {
  for (const module of USAGE_MODULES) {
    const strategy = getProviderUsageStrategy(module.id);
    assert.ok(PROVIDER_IDS.includes(module.id), module.id);
    assert.equal(strategy.capability, 'provider.usage');
    assert.equal(strategy.snapshotKind, USAGE_SNAPSHOT_KINDS[module.id] || '');
    assert.equal(typeof strategy.planLabel, 'function');
  }
  const fallback = getProviderUsageStrategy('nope');
  assert.equal(fallback.accountSnapshotRefresh, false);
  assert.equal(fallback.planLabel('pro', {}), '');
});

test('用量端口：两类「用量托管」名单含义不同、成员保持现状', () => {
  const flagged = (flag) => PROVIDER_IDS.filter((id) => getProviderUsageStrategy(id)[flag]).sort();
  // cline 于 2026-10-14 加入 accountSnapshotRefresh：它的额度由额度插件采集，
  // 账号状态读取时要按需刷新（见 lib/usage/quota/plugins/cline.js）。
  // 终端标题（ptyUsageStatus）刻意保持原样，不因新增 provider 改变用户可见面。
  assert.deepEqual(flagged('accountSnapshotRefresh'), ['agy', 'claude', 'cline', 'codex', 'gemini', 'grok', 'kimi', 'kiro']);
  assert.deepEqual(flagged('ptyUsageStatus'), ['claude', 'codex', 'gemini']);
});
