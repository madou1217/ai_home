'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateAccountHealth,
  pickHealthyAccount,
  rankHealthyAccounts,
  summarizeRejections
} = require('../lib/account/healthy-account-selector');

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

function account(ref, overrides = {}) {
  return {
    accountRef: ref,
    provider: 'codebuddy',
    cliAccountId: ref.slice(-1),
    status: 'up',
    configured: true,
    apiKeyMode: false,
    remainingPct: 60,
    ...overrides
  };
}

test('no model: the account with the most remaining quota wins', () => {
  const picked = pickHealthyAccount([
    account('acct_00000000000000000001', { remainingPct: 20 }),
    account('acct_00000000000000000002', { remainingPct: 80 }),
    account('acct_00000000000000000003', { remainingPct: 50 })
  ], { now: NOW });
  assert.ok(picked);
  assert.equal(picked.accountRef, 'acct_00000000000000000002');
  assert.equal(picked.remainingPct, 80);
});

test('unknown remaining is neutral, not exhausted', () => {
  const picked = pickHealthyAccount([
    account('acct_00000000000000000001', { remainingPct: 80 }),
    account('acct_00000000000000000002', { remainingPct: null }),
    account('acct_00000000000000000003', { remainingPct: 20 })
  ], { now: NOW });
  assert.equal(picked.accountRef, 'acct_00000000000000000001');

  const ranked = rankHealthyAccounts([
    account('acct_00000000000000000001', { remainingPct: 80 }),
    account('acct_00000000000000000002', { remainingPct: null }),
    account('acct_00000000000000000003', { remainingPct: 20 })
  ], { now: NOW });
  assert.deepEqual(ranked.map((item) => item.accountRef), [
    'acct_00000000000000000001',
    'acct_00000000000000000002',
    'acct_00000000000000000003'
  ]);
});

test('rate limited / auth invalid / routing blocked accounts are not healthy', () => {
  const rateLimited = evaluateAccountHealth(account('acct_00000000000000000001', {
    rateLimitUntil: NOW + 60_000
  }), { now: NOW });
  assert.equal(rateLimited.healthy, false);
  assert.equal(rateLimited.status, 'runtime:rate_limited');

  const authInvalid = evaluateAccountHealth(account('acct_00000000000000000002', {
    authInvalidUntil: NOW + 60_000
  }), { now: NOW });
  assert.equal(authInvalid.healthy, false);
  assert.equal(authInvalid.status, 'runtime:auth_invalid');

  const routing = evaluateAccountHealth(account('acct_00000000000000000003', {
    routingBlock: { kind: 'quota_exhausted', reason: 'usage_exhausted', observedAt: NOW, until: NOW + 60_000 }
  }), { now: NOW });
  assert.equal(routing.healthy, false);
  assert.equal(routing.status, 'runtime:quota_exhausted');
});

test('account health changes with time: an expired block is healthy again', () => {
  const candidate = account('acct_00000000000000000001', {
    rateLimitUntil: NOW + 60_000,
    cooldownUntil: NOW + 60_000
  });
  assert.equal(evaluateAccountHealth(candidate, { now: NOW }).healthy, false);
  assert.equal(evaluateAccountHealth(candidate, { now: NOW + 61_000 }).healthy, true);
});

test('quota exhausted / below the scheduling threshold are excluded', () => {
  const exhausted = evaluateAccountHealth(account('acct_00000000000000000001', {
    remainingPct: 0
  }), { now: NOW });
  assert.equal(exhausted.healthy, false);
  assert.equal(exhausted.status, 'quota_exhausted');

  const belowThreshold = evaluateAccountHealth(account('acct_00000000000000000002', {
    remainingPct: 3,
    schedulableStatus: 'blocked_by_policy',
    schedulableReason: 'usage_below_server_threshold'
  }), { now: NOW });
  assert.equal(belowThreshold.healthy, false);
  assert.equal(belowThreshold.status, 'blocked_by_policy');
});

test('disabled / unconfigured / api-key accounts follow the caller policy', () => {
  assert.equal(evaluateAccountHealth(account('acct_00000000000000000001', {
    status: 'down'
  }), { now: NOW }).healthy, false);
  assert.equal(evaluateAccountHealth(account('acct_00000000000000000002', {
    configured: false
  }), { now: NOW }).healthy, false);

  const apiKey = account('acct_00000000000000000003', { apiKeyMode: true, remainingPct: null });
  assert.equal(evaluateAccountHealth(apiKey, { now: NOW }).healthy, true);
  assert.equal(evaluateAccountHealth(apiKey, { now: NOW, allowApiKey: false }).healthy, false);
});

test('with a model, accounts whose catalog contains it are preferred', () => {
  const pool = [
    account('acct_00000000000000000001', { remainingPct: 90 }),
    account('acct_00000000000000000002', { remainingPct: 10 })
  ];
  const picked = pickHealthyAccount(pool, {
    now: NOW,
    model: 'glm-5.3',
    modelCatalog: {
      acct_00000000000000000001: ['gpt-5.6'],
      acct_00000000000000000002: ['glm-5.3']
    }
  });
  assert.equal(picked.accountRef, 'acct_00000000000000000002');
  assert.equal(picked.modelSupport, true);
});

test('with a model, requireModel=true hard-excludes unsupported accounts', () => {
  const ranked = rankHealthyAccounts([
    account('acct_00000000000000000001', { remainingPct: 90 }),
    account('acct_00000000000000000002', { remainingPct: 10 })
  ], {
    now: NOW,
    model: 'glm-5.3',
    modelCatalog: {
      acct_00000000000000000001: ['gpt-5.6'],
      acct_00000000000000000002: ['glm-5.3']
    },
    requireModel: true
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].accountRef, 'acct_00000000000000000002');
});

test('a model cooldown only excludes that model on that account', () => {
  const candidate = account('acct_00000000000000000001', {
    modelCooldowns: { 'glm-5.3': NOW + 60_000 }
  });
  assert.equal(evaluateAccountHealth(candidate, { now: NOW, model: 'glm-5.3' }).healthy, false);
  assert.equal(evaluateAccountHealth(candidate, { now: NOW, model: 'gpt-5.6' }).healthy, true);
  assert.equal(evaluateAccountHealth(candidate, { now: NOW }).healthy, true);
});

test('catalog unknown is not treated as unsupported', () => {
  const picked = pickHealthyAccount([
    account('acct_00000000000000000001', { remainingPct: 80 }),
    account('acct_00000000000000000002', { remainingPct: 10 })
  ], {
    now: NOW,
    model: 'glm-5.3',
    modelCatalog: { acct_00000000000000000002: ['glm-5.3'] }
  });
  assert.equal(picked.accountRef, 'acct_00000000000000000002');
});

test('model preference is a preference: an unsupported account still serves when it is the only one', () => {
  const picked = pickHealthyAccount([
    account('acct_00000000000000000001', { remainingPct: 90 })
  ], {
    now: NOW,
    model: 'glm-5.3',
    modelCatalog: { acct_00000000000000000001: ['gpt-5.6'] }
  });
  assert.ok(picked);
  assert.equal(picked.accountRef, 'acct_00000000000000000001');
  assert.equal(picked.modelSupport, false);
});

test('runtimeState nested in an account-state row is unwrapped', () => {
  const candidate = account('acct_00000000000000000001', {
    runtimeState: { rateLimitUntil: NOW + 60_000 }
  });
  assert.equal(evaluateAccountHealth(candidate, { now: NOW }).healthy, false);
});

test('rejections can be summarized for the user notice', () => {
  const evaluations = rankHealthyAccounts([
    account('acct_00000000000000000001', { remainingPct: 0 }),
    account('acct_00000000000000000002', { authInvalidUntil: NOW + 60_000 })
  ], { now: NOW, includeUnhealthy: true });
  const summary = summarizeRejections(evaluations);
  assert.match(summary, /quota_exhausted=1/);
  assert.match(summary, /runtime:auth_invalid=1/);
});
