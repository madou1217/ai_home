import assert from 'node:assert/strict';
import test from 'node:test';

import { quotaPlaceholderTitle } from './AccountRowContent.tsx';

test('quota placeholder title explains conclusion-style not_applicable instead of unknown', () => {
  // 结构性「不适用」（无原因，且非 API Key）：维持旧口径。
  assert.equal(
    quotaPlaceholderTitle({ apiKeyMode: false, quotaStatus: 'not_applicable', quotaReason: '' }),
    '额度未知'
  );
  // 结论型「不适用」（zcode 无套餐 / qoder Free 档）：给出「额度不适用」+ 原因。
  assert.match(
    quotaPlaceholderTitle({ apiKeyMode: false, quotaStatus: 'not_applicable', quotaReason: 'no_plan_balance' }),
    /^额度不适用：/
  );
  assert.match(
    quotaPlaceholderTitle({
      apiKeyMode: false, quotaStatus: 'not_applicable', quotaReason: 'qoder_no_consumable_credits'
    }),
    /^额度不适用：/
  );
  // API Key 模式不变。
  assert.equal(
    quotaPlaceholderTitle({ apiKeyMode: true, quotaStatus: 'not_applicable', quotaReason: '' }),
    '额度由上游管理'
  );
  // 探测类状态沿用桌面徽章文案 + 原因。
  assert.match(
    quotaPlaceholderTitle({
      apiKeyMode: false, quotaStatus: 'pending', quotaReason: 'provider_returned_no_numeric_usage'
    }),
    /^额度未知：/
  );
  assert.match(
    quotaPlaceholderTitle({ apiKeyMode: false, quotaStatus: 'probe_failed', quotaReason: 'timeout' }),
    /^采集失败：/
  );
});
