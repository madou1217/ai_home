'use strict';

// 回归守卫（2026-11-10 真机）：CodeBuddy 国际站积分耗尽只回
// `429 Credits exhausted … purchase add-on packs`，没有 `reset at`。
// 旧解析只认恢复时刻，整条报错被丢掉 → 账号冷却不落地，网关继续选它。
const test = require('node:test');
const assert = require('node:assert/strict');

const { readSessionLimitLine } = require('../lib/server/codebuddy-session-limit-observer');

const CREDITS_EXHAUSTED = '429 Credits exhausted. Please visit the link below to purchase '
  + 'add-on packs and get more credits: https://www.codebuddy.ai/profile/usage';

function line(providerData) {
  return {
    id: '01a1c546-de18-7c80-b4e5-6f1137d77f60',
    timestamp: 1794311118364,
    providerData
  };
}

test('credits exhausted 429 without a reset time is a hard-exhaustion observation', () => {
  const parsed = readSessionLimitLine(line({
    error: { status: 429, code: 14018, message: CREDITS_EXHAUSTED }
  }));
  assert.ok(parsed && parsed.limit);
  assert.equal(parsed.limit.hardExhaustion, true);
  assert.equal(parsed.limit.resetAtMs, 0);
  assert.equal(parsed.limit.code, 14018);
});

test('a 429 without credits wording and without a reset time is still ignored', () => {
  const parsed = readSessionLimitLine(line({
    error: { status: 429, code: 14018, message: '429 Too Many Requests' }
  }));
  assert.equal(parsed, null);
});

test('a timed 429 keeps its reset time and is not marked hard exhaustion', () => {
  const parsed = readSessionLimitLine(line({
    error: {
      status: 429,
      code: 6004,
      message: 'API Error: 429 usage exceeds frequency limit, '
        + 'your usage will reset at 2026-11-04 13:34:21 UTC+8'
    }
  }));
  assert.ok(parsed && parsed.limit);
  assert.equal(parsed.limit.hardExhaustion, false);
  assert.ok(parsed.limit.resetAtMs > 0);
});
