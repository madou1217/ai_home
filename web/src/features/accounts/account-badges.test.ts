import assert from 'node:assert/strict';
import test from 'node:test';

import type { Account } from '@/types';
import {
  getAccountRegionMeta,
  getPlanTagColor,
  getPlanTagLabel
} from './AccountBadges.tsx';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    provider: 'codex',
    accountRef: 'acct_test',
    status: 'up',
    displayName: 'test',
    configured: true,
    apiKeyMode: false,
    remainingPct: null,
    updatedAt: 0,
    planType: 'free',
    email: 'user@example.com',
    ...overrides
  };
}

test('getPlanTagLabel prefers auth mode, then branded plan name, then plan type', () => {
  assert.equal(getPlanTagLabel(makeAccount({ apiKeyMode: true })), '密钥');
  assert.equal(getPlanTagLabel(makeAccount({ apiKeyMode: false, planName: 'Allegretto' })), 'Allegretto');
  assert.equal(getPlanTagLabel(makeAccount({ apiKeyMode: false, planType: 'pro' })), 'pro');
  assert.equal(getPlanTagLabel(makeAccount({ apiKeyMode: false })), 'free');
});

test('getPlanTagColor maps api key and branded kimi tiers', () => {
  assert.equal(getPlanTagColor(makeAccount({ apiKeyMode: true })), 'cyan');
  assert.equal(getPlanTagColor(makeAccount({ planName: 'andante' })), 'default');
  assert.equal(getPlanTagColor(makeAccount({ planName: 'moderato' })), 'green');
  assert.equal(getPlanTagColor(makeAccount({ planName: 'allegretto' })), 'geekblue');
  assert.equal(getPlanTagColor(makeAccount({ planName: 'allegro' })), 'gold');
});

test('getPlanTagColor maps plan type tiers and normalizes planName case', () => {
  assert.equal(getPlanTagColor(makeAccount({ planType: 'free' })), 'default');
  assert.equal(getPlanTagColor(makeAccount({ planType: 'pro' })), 'green');
  assert.equal(getPlanTagColor(makeAccount({ planType: 'ultra' })), 'purple');
  assert.equal(getPlanTagColor(makeAccount({ planType: 'team' })), 'blue');
  assert.equal(getPlanTagColor(makeAccount({ planType: 'plus' })), 'green');
  assert.equal(getPlanTagColor(makeAccount({ planType: 'business' })), 'gold');
  assert.equal(getPlanTagColor(makeAccount({ planType: 'unknown' })), 'default');
  assert.equal(getPlanTagColor(makeAccount({ planType: 'ALLEGRO' })), 'default');
});

test('getAccountRegionMeta exposes Kimi effective region and explicit unknown state', () => {
  assert.deepEqual(getAccountRegionMeta(makeAccount({ provider: 'kimi', region: 'china' })), {
    color: 'blue',
    label: '中国区',
    endpoint: 'www.kimi.com'
  });
  assert.deepEqual(getAccountRegionMeta(makeAccount({ provider: 'kimi', region: 'overseas' })), {
    color: 'geekblue',
    label: '海外区',
    endpoint: 'www.kimi.ai'
  });
  assert.deepEqual(getAccountRegionMeta(makeAccount({ provider: 'kimi' })), {
    color: 'default',
    label: '区域未知',
    endpoint: ''
  });
  assert.equal(getAccountRegionMeta(makeAccount({ provider: 'codex', region: 'china' })), null);
});

test('getAccountDisplayBadgeMeta mirrors renderAccountDisplayBadge branch order', async () => {
  const { getAccountDisplayBadgeMeta, getAccountStatusDetailLines } = await import('./AccountBadges.tsx');
  assert.deepEqual(getAccountDisplayBadgeMeta(makeAccount({ configured: false, authPendingStale: true })), { status: 'warning', label: '授权超时' });
  assert.deepEqual(getAccountDisplayBadgeMeta(makeAccount({ runtimeStatus: 'auth_invalid' })), { status: 'error', label: '需要重新登录' });
  assert.deepEqual(getAccountDisplayBadgeMeta(makeAccount({ status: 'down' })), { status: 'default', label: '已关闭' });
  assert.deepEqual(getAccountDisplayBadgeMeta(makeAccount({ runtimeStatus: 'rate_limited' })), { status: 'warning', label: '限流中' });
  assert.deepEqual(getAccountDisplayBadgeMeta(makeAccount({ remainingPct: 0 })), { status: 'error', label: '已耗尽' });
  assert.deepEqual(getAccountDisplayBadgeMeta(makeAccount({ apiKeyMode: true })), { status: 'success', label: '可调度' });
  assert.deepEqual(getAccountDisplayBadgeMeta(makeAccount({ remainingPct: 50, quotaStatus: 'available' })), { status: 'success', label: '正常' });
  assert.deepEqual(getAccountDisplayBadgeMeta(makeAccount({ remainingPct: 50, quotaStatus: 'pending' })), { status: 'processing', label: '等待采集' });
  assert.equal(getAccountStatusDetailLines(makeAccount({ runtimeStatus: 'rate_limited', runtimeReason: 'boom' })).length, 1);
  assert.equal(getAccountStatusDetailLines(makeAccount({ remainingPct: 50, quotaStatus: 'available' })).length, 0);
});
