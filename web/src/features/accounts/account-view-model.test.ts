import assert from 'node:assert/strict';
import test from 'node:test';

import type { Account } from '@/types';
import {
  ACCOUNT_STATUS_FILTER_OPTIONS,
  FAMILY_KEYS,
  aggregateFamilyActivity,
  buildProviderStats,
  canViewQuotaResetHistory,
  countPendingIssues,
  countUnavailable,
  familyRepresentative,
  filterAccountsByView,
  getAccountAppSupport,
  getAccountLaunchBlockReason,
  getCodexAppAccountActionMeta,
  getDefaultAccountActionMeta,
  getStatusFilterCount,
  isProviderFilter,
  parseAccountRouteTarget,
  resolveAddAccountDefaultProvider
} from './account-view-model.ts';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    provider: 'codex',
    accountRef: 'acct_a',
    status: 'up',
    displayName: 'a',
    configured: true,
    apiKeyMode: false,
    remainingPct: 80,
    updatedAt: 0,
    planType: 'plus',
    email: 'a@example.com',
    quotaStatus: 'available',
    ...overrides
  };
}

test('provider stats count each account into all + its product family bucket', () => {
  const accounts = [
    makeAccount({ accountRef: 'acct_1' }),
    makeAccount({ accountRef: 'acct_2', status: 'down' }),
    makeAccount({ accountRef: 'acct_3', runtimeStatus: 'auth_invalid' }),
    makeAccount({ accountRef: 'acct_4', provider: 'claude', remainingPct: 0 })
  ];
  const stats = buildProviderStats(accounts);
  assert.equal(stats.all.total, 4);
  assert.equal(stats.all.healthy, 1);
  assert.equal(stats.all.disabled, 1);
  assert.equal(stats.all.reauthRequired, 1);
  assert.equal(stats.all.exhausted, 1);
  assert.equal(stats.codex.total, 3);
  assert.equal(stats.claude.total, 1);
  assert.equal(getStatusFilterCount(stats.all, 'all'), 4);
  assert.equal(getStatusFilterCount(stats.all, 'reauth_required'), 1);
  assert.equal(countPendingIssues(stats.all), 1);
  assert.equal(countUnavailable(stats.all), 1);
});

test('filterAccountsByView filters by family and display state', () => {
  const accounts = [
    makeAccount({ accountRef: 'acct_1' }),
    makeAccount({ accountRef: 'acct_2', status: 'down' }),
    makeAccount({ accountRef: 'acct_3', provider: 'claude' })
  ];
  assert.deepEqual(filterAccountsByView(accounts, 'all', 'all').map((a) => a.accountRef), ['acct_1', 'acct_2', 'acct_3']);
  assert.deepEqual(filterAccountsByView(accounts, 'codex', 'all').map((a) => a.accountRef), ['acct_1', 'acct_2']);
  assert.deepEqual(filterAccountsByView(accounts, 'codex', 'disabled').map((a) => a.accountRef), ['acct_2']);
});

test('status filter options cover every display state once', () => {
  const values = ACCOUNT_STATUS_FILTER_OPTIONS.map((option) => option.value);
  assert.equal(new Set(values).size, values.length);
  assert.equal(values[0], 'all');
  assert.equal(values.length, 9);
});

test('family helpers keep the tab axis on product families', () => {
  assert.ok(FAMILY_KEYS.includes('codex'));
  assert.equal(isProviderFilter('all'), true);
  assert.equal(isProviderFilter('codex'), true);
  assert.equal(isProviderFilter('not-a-provider'), false);
  assert.equal(familyRepresentative('codex'), 'codex');
  assert.equal(resolveAddAccountDefaultProvider('all'), undefined);
  assert.equal(resolveAddAccountDefaultProvider('codex'), 'codex');
});

test('parseAccountRouteTarget only accepts real provider ids with an accountRef', () => {
  assert.deepEqual(parseAccountRouteTarget('?provider=codex&accountRef=acct_1'), { provider: 'codex', accountRef: 'acct_1' });
  assert.equal(parseAccountRouteTarget('?provider=codex'), null);
  assert.equal(parseAccountRouteTarget('?provider=nope&accountRef=acct_1'), null);
});

test('launch guard blocks reauth-required and unconfigured accounts', () => {
  assert.equal(getAccountLaunchBlockReason(makeAccount(), 'CLI'), null);
  assert.equal(
    getAccountLaunchBlockReason(makeAccount({ runtimeStatus: 'auth_invalid' }), 'CLI'),
    '需要重新登录后才能打开 CLI'
  );
  assert.equal(
    getAccountLaunchBlockReason(makeAccount({ configured: false }), 'Desktop'),
    '账号未配置，完成授权后可打开 Desktop'
  );
});

test('app support reads host entries and capabilities', () => {
  const support = getAccountAppSupport(makeAccount(), { codex: { desktop: true, cli: false } }, { codex: { desktop: true, cli: true } });
  assert.equal(support.desktopInstalled, true);
  assert.equal(support.desktopSupported, true);
  assert.equal(support.cliInstalled, false);
  const unloaded = getAccountAppSupport(makeAccount(), null, {});
  assert.equal(unloaded.desktopSupported, false);
  assert.equal(unloaded.cliSupported, false);
});

test('role action metas mirror the desktop menu labels and guards', () => {
  assert.deepEqual(getDefaultAccountActionMeta({ isDefault: true, configured: true }), { label: '取消默认账号', disabled: false, active: true });
  assert.deepEqual(getDefaultAccountActionMeta({ isDefault: false, configured: false }), { label: '未配置账号不能设为默认账号', disabled: true, active: false });
  assert.equal(getCodexAppAccountActionMeta(makeAccount({ provider: 'claude' })), null);
  assert.deepEqual(getCodexAppAccountActionMeta(makeAccount({ apiKeyMode: true })), {
    label: '密钥账号不能设为 Codex App 账号',
    disabled: true,
    active: false
  });
  assert.equal(canViewQuotaResetHistory({ apiKeyMode: true }), false);
});

test('aggregateFamilyActivity sums in-flight and rate per family', () => {
  const accounts = [makeAccount({ accountRef: 'acct_1' }), makeAccount({ accountRef: 'acct_2' })];
  const activity = aggregateFamilyActivity(accounts, (record) => ({
    provider: record.provider,
    accountRef: record.accountRef,
    inFlight: 1,
    rate: 2,
    lastActivityAt: 10,
    updatedAt: 20
  }));
  assert.equal(activity.codex.inFlight, 2);
  assert.equal(activity.codex.rate, 4);
  assert.equal(activity.codex.accountRef, '*');
});
