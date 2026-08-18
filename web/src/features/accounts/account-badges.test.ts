import assert from 'node:assert/strict';
import test from 'node:test';

import type { Account } from '@/types';
import { getPlanTagColor, getPlanTagLabel } from './AccountBadges.tsx';

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