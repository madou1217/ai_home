'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DECISIONS,
  DEFAULT_SOAK_MS,
  normalizeUpgradePolicyConfig,
  decide
} = require('../lib/server/provider-cli-upgrade/upgrade-policy');

const NOW = 1_757_000_000_000;
const LONG_AGO = NOW - (10 * 24 * 60 * 60 * 1000);

function base(overrides = {}) {
  return {
    now: NOW,
    enabled: true,
    pinnable: true,
    baselineHealthy: true,
    knownGoodRollbackable: true,
    installedVersion: '0.153.4',
    latestVersion: '0.154.0',
    publishedAt: LONG_AGO,
    blockedVersions: [],
    ...overrides
  };
}

test('soak 期满、渠道可钉版本时才判定升级', () => {
  const result = decide(base());
  assert.equal(result.decision, DECISIONS.UPGRADE);
  assert.equal(result.targetVersion, '0.154.0');
});

// 本机 codex 实际装的就是 0.154.0-alpha.3，而 npm dist-tags.latest 是 0.154.0。
// 用户明确选了「稳定版」，所以从 alpha 回到 stable 是要做的，反向则不做。
test('从预发布版升到稳定版是允许的，反向不降级', () => {
  assert.equal(decide(base({ installedVersion: '0.154.0-alpha.3' })).decision, DECISIONS.UPGRADE);

  const downgrade = decide(base({ installedVersion: '0.155.0' }));
  assert.equal(downgrade.decision, DECISIONS.SKIP);
  assert.equal(downgrade.reason, 'up_to_date');
});

// 上游若把预发布推上 latest，不能跟。
test('latest 本身是预发布版时不跟进', () => {
  const result = decide(base({ latestVersion: '0.155.0-alpha.1' }));
  assert.equal(result.decision, DECISIONS.SKIP);
  assert.equal(result.reason, 'latest_is_prerelease');
});

test('soak 未满不升级，并报出剩余时间', () => {
  const result = decide(base({ publishedAt: NOW - 1000 }));
  assert.equal(result.decision, DECISIONS.SKIP);
  assert.equal(result.reason, 'soaking');
  assert.equal(result.targetVersion, '0.154.0');
  assert.ok(result.soakRemainingMs > 0 && result.soakRemainingMs <= DEFAULT_SOAK_MS);
});

// 拿不到发布时间时先等，但不能无限假装在等——超过上限要显式暴露。
test('发布时间缺失：先等待，超过上限后暴露 soak_unknown', () => {
  const waiting = decide(base({ publishedAt: 0, soakUnknownCount: 2 }));
  assert.equal(waiting.reason, 'soak_pending_unknown_publish_time');

  const exposed = decide(base({ publishedAt: 0, soakUnknownCount: 5 }));
  assert.equal(exposed.reason, 'soak_unknown');
  assert.equal(exposed.targetVersion, '0.154.0');
});

test('验证失败过的版本永不再试', () => {
  const result = decide(base({ blockedVersions: ['0.154.0'] }));
  assert.equal(result.decision, DECISIONS.SKIP);
  assert.equal(result.reason, 'version_blocked');
});

// 没有安全网就不许起跳：这两条是「升上去回不来」的唯一防线。
test('基线不健康或基线回不去时拒绝升级', () => {
  assert.equal(decide(base({ baselineHealthy: false })).reason, 'baseline_unhealthy');
  assert.equal(decide(base({ knownGoodRollbackable: false })).reason, 'known_good_not_rollbackable');
});

test('用户钉版本与渠道不可钉版本都判定为 ineligible', () => {
  assert.deepEqual(
    decide(base({ userPin: '0.153.4' })),
    { decision: DECISIONS.INELIGIBLE, targetVersion: '', reason: 'user_pinned' }
  );
  assert.equal(decide(base({ pinnable: false })).reason, 'channel_not_pinnable');
  assert.equal(decide(base({ enabled: false })).reason, 'disabled');
});

test('版本信息缺失时只跳过，不猜测', () => {
  assert.equal(decide(base({ installedVersion: '' })).reason, 'installed_version_unknown');
  assert.equal(decide(base({ latestVersion: '' })).reason, 'latest_version_unknown');
  assert.equal(decide(base({ latestVersion: 'not-a-version' })).reason, 'latest_version_unparsable');
});

test('配置归一化夹住非法值', () => {
  assert.deepEqual(normalizeUpgradePolicyConfig({ soakMs: -1, soakUnknownLimit: 0 }), {
    soakMs: DEFAULT_SOAK_MS,
    soakUnknownLimit: 5
  });
  assert.deepEqual(normalizeUpgradePolicyConfig({ soakMs: 1000, soakUnknownLimit: 2 }), {
    soakMs: 1000,
    soakUnknownLimit: 2
  });
});
