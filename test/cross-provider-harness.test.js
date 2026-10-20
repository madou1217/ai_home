'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RELAY_PROFILES,
  supportsCrossProviderHarness
} = require('../lib/cli/services/ai-cli/relay/cli-relay-profile');

// 跨 Provider harness = 账号钉选 + 显式跨 Provider 支持。两个条件必须同时成立：
// kimi 能钉账号但只声明了同 Provider relay，opencode 只有网关 profile。
test('cross-provider harness capability requires both account pinning and explicit support', () => {
  assert.equal(supportsCrossProviderHarness('claude'), true);
  assert.equal(supportsCrossProviderHarness('codex'), true);
  assert.equal(supportsCrossProviderHarness('kimi'), false);
  assert.equal(supportsCrossProviderHarness('opencode'), false);
  assert.equal(supportsCrossProviderHarness('unknown'), false);
  assert.equal(supportsCrossProviderHarness(''), false);
});

test('every cross-provider harness declares the env builder it is selected for', () => {
  for (const [provider, profile] of Object.entries(RELAY_PROFILES)) {
    if (!supportsCrossProviderHarness(provider)) continue;
    assert.equal(typeof profile.buildCrossProviderEnv, 'function', provider);
    const env = profile.buildCrossProviderEnv({ GATEWAY: '1' }, 'acct_0123456789abcdef0123');
    assert.equal(typeof env, 'object', provider);
  }
  // 声明了跨 Provider 能力的 profile 不允许再过不了能力判定（两处口径同源）。
  for (const provider of Object.keys(RELAY_PROFILES)) {
    assert.equal(
      supportsCrossProviderHarness(provider),
      typeof RELAY_PROFILES[provider].buildCrossProviderEnv === 'function'
        && typeof RELAY_PROFILES[provider].buildAccountRelayEnv === 'function'
    );
  }
});
