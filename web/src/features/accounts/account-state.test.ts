import assert from 'node:assert/strict';
import test from 'node:test';

import type { Account } from '@/types';
import {
  canCopyAccountEmail,
  canEditAccountConfig,
  canReauthAccount,
  canRefreshUsageAccount,
  formatQuotaReason,
  formatSchedulableReason,
  getAccountDisplayState,
  getClaudeCredentialMode,
  getEffectiveRemainingPct,
  getReauthActionLabel,
  getUsageSnapshotRemainingPct,
  getUsageSortValue,
  hasBlockingRuntimeStatus,
  hasKnownUsage,
  isAccountEnabled,
  isClaudeAuthTokenMode,
  isRecoveryAccount,
  mergeAccountRecord,
  mergeAccounts,
  mergeSingleAccount,
  partitionAccountsByRecovery,
  reconcileAccountAfterReauthSuccess
} from './account-state.ts';

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

test('isClaudeAuthTokenMode normalizes underscore and case variants', () => {
  assert.equal(isClaudeAuthTokenMode('auth-token'), true);
  assert.equal(isClaudeAuthTokenMode('claude-code-token'), true);
  assert.equal(isClaudeAuthTokenMode('AUTH_TOKEN'), true);
  assert.equal(isClaudeAuthTokenMode('auth_token'), true);
  assert.equal(isClaudeAuthTokenMode('api-key'), false);
  assert.equal(isClaudeAuthTokenMode(undefined), false);
  assert.equal(isClaudeAuthTokenMode(''), false);
});

test('getClaudeCredentialMode prefers credentialType then authType then authMode', () => {
  assert.equal(getClaudeCredentialMode({ credentialType: 'auth-token' }), 'auth-token');
  assert.equal(getClaudeCredentialMode({ authType: 'claude-code-token' }), 'auth-token');
  assert.equal(getClaudeCredentialMode({ authMode: 'auth-token' }), 'auth-token');
  assert.equal(getClaudeCredentialMode({ authMode: 'api-key' }), 'api-key');
  assert.equal(getClaudeCredentialMode(null), 'api-key');
  assert.equal(getClaudeCredentialMode(undefined), 'api-key');
});

test('canCopyAccountEmail allows api key accounts and trimmed non-empty emails', () => {
  assert.equal(canCopyAccountEmail({ apiKeyMode: true, email: '', baseUrl: '' }), true);
  assert.equal(canCopyAccountEmail({ apiKeyMode: false, email: 'user@example.com', baseUrl: '' }), true);
  assert.equal(canCopyAccountEmail({ apiKeyMode: false, email: '  ', baseUrl: '' }), false);
  assert.equal(canCopyAccountEmail({ apiKeyMode: false, email: '', baseUrl: 'https://x' }), false);
});

test('isAccountEnabled only treats "down" as disabled', () => {
  assert.equal(isAccountEnabled({ status: 'up' }), true);
  assert.equal(isAccountEnabled({ status: 'down' }), false);
  assert.equal(isAccountEnabled({ status: 'DOWN' }), false);
  assert.equal(isAccountEnabled({}), true);
});

test('system-retained accounts are separated from the current pool without treating manual down as recovery', () => {
  const retained = makeAccount({
    accountRef: 'acct_retained',
    status: 'down',
    runtimeStatus: 'auth_invalid',
    runtimeReason: 'account_recovery_required:refresh_http_401'
  });
  const manuallyDisabled = makeAccount({
    accountRef: 'acct_manual',
    status: 'down',
    runtimeStatus: 'auth_invalid',
    runtimeReason: 'token_expired'
  });
  const healthy = makeAccount({ accountRef: 'acct_healthy' });

  assert.equal(isRecoveryAccount(retained), true);
  assert.equal(isRecoveryAccount(manuallyDisabled), false);
  assert.equal(isRecoveryAccount(healthy), false);
  assert.deepEqual(partitionAccountsByRecovery([healthy, retained, manuallyDisabled]), {
    currentAccounts: [healthy, manuallyDisabled],
    recoveryAccounts: [retained]
  });
});

test('successful reauth immediately returns a retained account to the current pool', () => {
  const retained = makeAccount({
    accountRef: 'acct_retained',
    status: 'down',
    runtimeStatus: 'auth_invalid',
    runtimeUntil: Date.now() + 60_000,
    runtimeReason: 'account_recovery_required:refresh_http_401',
    schedulableStatus: 'blocked_by_runtime',
    schedulableReason: 'auth_invalid'
  });
  const healthy = makeAccount({ accountRef: 'acct_healthy' });

  const next = reconcileAccountAfterReauthSuccess([retained, healthy], retained.accountRef);

  assert.notEqual(next[0], retained);
  assert.equal(next[0].status, 'up');
  assert.equal(next[0].configured, true);
  assert.equal(next[0].runtimeStatus, undefined);
  assert.equal(next[0].runtimeUntil, undefined);
  assert.equal(next[0].runtimeReason, undefined);
  assert.equal(next[0].schedulableStatus, undefined);
  assert.equal(next[0].schedulableReason, undefined);
  assert.equal(next[1], healthy);
  assert.equal(isRecoveryAccount(next[0]), false);
});

test('successful reauth re-enables a legacy markerless down account and ignores unknown accounts', () => {
  const legacyMarkerless = makeAccount({
    accountRef: 'acct_legacy',
    status: 'down',
    runtimeStatus: 'auth_invalid',
    runtimeReason: 'token_expired'
  });
  const next = reconcileAccountAfterReauthSuccess([legacyMarkerless], legacyMarkerless.accountRef);

  assert.equal(next[0].status, 'up');
  assert.equal(next[0].runtimeStatus, undefined);
  assert.equal(
    reconcileAccountAfterReauthSuccess(next, 'acct_unknown'),
    next
  );
});

test('hasBlockingRuntimeStatus ignores healthy and empty states', () => {
  assert.equal(hasBlockingRuntimeStatus({ runtimeStatus: 'rate_limited' }), true);
  assert.equal(hasBlockingRuntimeStatus({ runtimeStatus: 'healthy' }), false);
  assert.equal(hasBlockingRuntimeStatus({ runtimeStatus: '' }), false);
  assert.equal(hasBlockingRuntimeStatus({}), false);
});

test('getAccountDisplayState maps each blocking condition to its kind', () => {
  assert.equal(getAccountDisplayState(makeAccount({ status: 'down' })), 'disabled');
  assert.equal(getAccountDisplayState(makeAccount({ configured: false })), 'unconfigured');
  assert.equal(getAccountDisplayState(makeAccount({ runtimeStatus: 'auth_invalid' })), 'runtime_blocked');
  assert.equal(
    getAccountDisplayState(makeAccount({ remainingPct: 0, quotaStatus: 'available' })),
    'exhausted'
  );
  assert.equal(getAccountDisplayState(makeAccount({ quotaStatus: 'exhausted' })), 'exhausted');
  assert.equal(
    getAccountDisplayState(makeAccount({ schedulableStatus: 'blocked_by_policy' })),
    'policy_blocked'
  );
  assert.equal(getAccountDisplayState(makeAccount({ quotaStatus: 'probe_failed' })), 'usage_attention');
});

test('getAccountDisplayState treats unknown quota for oauth without usage as attention', () => {
  assert.equal(getAccountDisplayState(makeAccount({ quotaStatus: 'not_applicable' })), 'healthy');
  assert.equal(
    getAccountDisplayState(makeAccount({ quotaStatus: 'available', remainingPct: 50 })),
    'healthy'
  );
  // OAuth 账号完全没有用量信息 → 需要关注
  assert.equal(getAccountDisplayState(makeAccount({ remainingPct: null })), 'usage_attention');
  // API Key 账号不需要用量信息
  assert.equal(
    getAccountDisplayState(makeAccount({ apiKeyMode: true, remainingPct: null })),
    'healthy'
  );
});

test('usage refresh gate: configured oauth accounts only, not_applicable excluded', () => {
  assert.equal(canRefreshUsageAccount(makeAccount({ configured: true, apiKeyMode: false })), true);
  assert.equal(canRefreshUsageAccount(makeAccount({ configured: true, apiKeyMode: true })), false);
  assert.equal(canRefreshUsageAccount(makeAccount({ configured: false, apiKeyMode: false })), false);
  assert.equal(
    canRefreshUsageAccount(makeAccount({ configured: true, apiKeyMode: false, quotaStatus: 'not_applicable' })),
    false
  );
});

test('reauth and edit gates depend on apiKeyMode only', () => {
  assert.equal(canReauthAccount({ apiKeyMode: false }), true);
  assert.equal(canReauthAccount({ apiKeyMode: true }), false);
  assert.equal(canEditAccountConfig({ apiKeyMode: true }), true);
  assert.equal(canEditAccountConfig({ apiKeyMode: false }), false);
});

test('getReauthActionLabel distinguishes pending, unconfigured and configured states', () => {
  assert.equal(getReauthActionLabel({ configured: true, authPending: true, authPendingStale: false }), '继续授权');
  assert.equal(getReauthActionLabel({ configured: true, authPending: true, authPendingStale: true }), '重新登录');
  assert.equal(getReauthActionLabel({ configured: false }), '重新授权');
  assert.equal(getReauthActionLabel({ configured: true }), '重新登录');
});

test('getEffectiveRemainingPct prefers snapshot and clamps into 0..100', () => {
  assert.equal(
    getEffectiveRemainingPct(makeAccount({
      provider: 'codex',
      remainingPct: 42,
      usageSnapshot: {
        kind: 'codex_oauth_status',
        capturedAt: 0,
        entries: [{ remainingPct: 12, windowResetAt: 0, windowResetIn: '', windowDurationMinutes: 0 }]
      }
    })),
    12
  );
  assert.equal(getEffectiveRemainingPct(makeAccount({ remainingPct: 150 })), 100);
  assert.equal(getEffectiveRemainingPct(makeAccount({ remainingPct: -5 })), 0);
  assert.equal(getEffectiveRemainingPct(makeAccount({ remainingPct: null })), null);
  assert.equal(getEffectiveRemainingPct(makeAccount({ remainingPct: NaN as unknown as null })), null);
});

test('getUsageSnapshotRemainingPct reads entries for codex/claude/kimi and models for gemini/agy', () => {
  assert.equal(
    getUsageSnapshotRemainingPct(makeAccount({
      provider: 'codex',
      usageSnapshot: {
        kind: 'codex_oauth_status',
        capturedAt: 0,
        entries: [
          { remainingPct: 30, windowResetAt: 0, windowResetIn: '', windowDurationMinutes: 0 },
          { remainingPct: 20, windowResetAt: 0, windowResetIn: '', windowDurationMinutes: 0 }
        ]
      }
    })),
    20
  );
  assert.equal(
    getUsageSnapshotRemainingPct(makeAccount({
      provider: 'gemini',
      usageSnapshot: {
        kind: 'gemini_oauth_stats',
        capturedAt: 0,
        models: [
          { modelId: 'a', remainingPct: 80, resetAt: 0, resetIn: '', windowDurationMinutes: 0 },
          { modelId: 'b', remainingPct: 55, resetAt: 0, resetIn: '', windowDurationMinutes: 0 }
        ]
      }
    })),
    55
  );
  assert.equal(getUsageSnapshotRemainingPct(makeAccount({})), null);
});

test('hasKnownUsage and getUsageSortValue follow effective remaining pct', () => {
  assert.equal(hasKnownUsage(makeAccount({ apiKeyMode: true, remainingPct: 50 })), false);
  assert.equal(hasKnownUsage(makeAccount({ remainingPct: 50 })), true);
  assert.equal(hasKnownUsage(makeAccount({ remainingPct: null })), false);
  assert.equal(getUsageSortValue(makeAccount({ remainingPct: 50 })), 50);
  assert.equal(getUsageSortValue(makeAccount({ remainingPct: null })), -1);
});

test('formatSchedulableReason maps known codes to human copy and falls back', () => {
  assert.match(formatSchedulableReason('codex_free_plan_below_server_min_remaining'), /Free 账号剩余额度/);
  assert.match(formatSchedulableReason('codex_free_plan_missing_rate_limits'), /Free/);
  assert.match(formatSchedulableReason('codex_team_plan_missing_rate_limits'), /Team/);
  assert.match(formatSchedulableReason('agy_access_token_required'), /AGY_ACCESS_TOKEN/);
  assert.equal(formatSchedulableReason(''), '');
  assert.equal(formatSchedulableReason(undefined), '');
});

test('formatQuotaReason delegates to account issue reason formatting', () => {
  assert.equal(formatQuotaReason(''), '');
  assert.equal(formatQuotaReason(undefined), '');
  assert.equal(typeof formatQuotaReason('some_reason'), 'string');
});

test('mergeAccountRecord clears live fields for api key mode accounts', () => {
  const current = makeAccount({
    apiKeyMode: false,
    runtimeStatus: 'running',
    runtimeUntil: 123,
    runtimeReason: 'probe',
    usageSnapshot: {
      kind: 'codex_oauth_status',
      capturedAt: 1,
      entries: []
    },
    remainingPct: 42,
    quotaStatus: 'ok',
    quotaReason: '',
    schedulableStatus: 'ok',
    schedulableReason: ''
  });
  const merged = mergeAccountRecord(current, makeAccount({ apiKeyMode: true }));
  assert.equal(merged.apiKeyMode, true);
  assert.equal(merged.runtimeStatus, undefined);
  assert.equal(merged.runtimeUntil, undefined);
  assert.equal(merged.runtimeReason, undefined);
  assert.equal(merged.usageSnapshot, null);
  assert.equal(merged.remainingPct, null);
  assert.equal(merged.quotaStatus, undefined);
  assert.equal(merged.quotaReason, undefined);
  assert.equal(merged.schedulableStatus, undefined);
  assert.equal(merged.schedulableReason, undefined);
});

test('mergeAccountRecord keeps email, planType and displayName when incoming omits them', () => {
  const current = makeAccount({
    displayName: 'My Claude',
    planType: 'pro',
    email: 'user@example.com'
  });
  const merged = mergeAccountRecord(current, makeAccount({
    accountRef: 'acct_other',
    displayName: 'acct_other',
    planType: 'oauth',
    email: ''
  }));
  assert.equal(merged.email, 'user@example.com');
  assert.equal(merged.planType, 'pro');
  assert.equal(merged.displayName, 'My Claude');
});

test('mergeAccountRecord preserves live fields only when requested', () => {
  const current = makeAccount({
    remainingPct: 80,
    updatedAt: 500,
    lastUsedAt: 400,
    usageSnapshot: {
      kind: 'codex_oauth_status',
      capturedAt: 1,
      entries: []
    },
    runtimeStatus: 'running'
  });
  const incoming = makeAccount({});
  const plain = mergeAccountRecord(current, incoming);
  assert.equal(plain.remainingPct, null);
  assert.equal(plain.runtimeStatus, 'running');
  const preserved = mergeAccountRecord(current, incoming, { preserveLiveFields: true });
  assert.equal(preserved.remainingPct, 80);
  assert.equal(preserved.updatedAt, 500);
  assert.equal(preserved.lastUsedAt, 400);
  assert.equal(preserved.runtimeStatus, 'running');
  assert.deepEqual(preserved.usageSnapshot, {
    kind: 'codex_oauth_status',
    capturedAt: 1,
    entries: []
  });
});

test('mergeAccounts merges by accountRef and keeps incoming order', () => {
  const current = [
    makeAccount({ accountRef: 'acct_a', displayName: 'A-old', remainingPct: 10 }),
    makeAccount({ accountRef: 'acct_b', displayName: 'B', remainingPct: 20 })
  ];
  const incoming = [
    makeAccount({ accountRef: 'acct_c', displayName: 'C', remainingPct: 30 }),
    makeAccount({ accountRef: 'acct_a', displayName: 'A-new', remainingPct: null })
  ];
  const merged = mergeAccounts(current, incoming);
  assert.deepEqual(merged.map((account) => account.accountRef), ['acct_c', 'acct_a']);
  assert.equal(merged[1].displayName, 'A-new');
  assert.equal(merged[1].remainingPct, null);
});

test('mergeAccounts preserves live fields of existing accounts when requested', () => {
  const current = [
    makeAccount({ accountRef: 'acct_a', remainingPct: 66, updatedAt: 900 })
  ];
  const incoming = [
    makeAccount({ accountRef: 'acct_a', remainingPct: null, updatedAt: 0 })
  ];
  const merged = mergeAccounts(current, incoming, { preserveLiveFields: true });
  assert.equal(merged[0].remainingPct, 66);
  assert.equal(merged[0].updatedAt, 900);
});

test('mergeSingleAccount updates an existing account in place', () => {
  const current = [
    makeAccount({ accountRef: 'acct_a', displayName: 'old' }),
    makeAccount({ accountRef: 'acct_b', displayName: 'b' })
  ];
  const merged = mergeSingleAccount(current, makeAccount({ accountRef: 'acct_a', displayName: 'new' }));
  assert.equal(merged.length, 2);
  assert.equal(merged[0].displayName, 'new');
  assert.equal(merged[1].displayName, 'b');
});

test('mergeSingleAccount appends when the account is unknown', () => {
  const current = [makeAccount({ accountRef: 'acct_a' })];
  const merged = mergeSingleAccount(current, makeAccount({ accountRef: 'acct_new', displayName: 'new' }));
  assert.equal(merged.length, 2);
  assert.equal(merged[1].accountRef, 'acct_new');
  assert.equal(current.length, 1);
});
