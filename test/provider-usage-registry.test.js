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
  assert.deepEqual(flagged('accountSnapshotRefresh'), ['agy', 'claude', 'codex', 'gemini', 'kimi']);
  assert.deepEqual(flagged('ptyUsageStatus'), ['claude', 'codex', 'gemini']);
});
