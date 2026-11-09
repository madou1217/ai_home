'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAccountSelectionService } = require('../lib/cli/services/account/selection');

function ref(n) {
  return 'acct_' + String(n).padStart(20, '0');
}

function createService(input = {}) {
  const records = input.records || {};
  const derived = input.derived || {};
  const runtime = input.runtime || {};
  const service = createAccountSelectionService({
    fs: {},
    aiHomeDir: '/tmp/aih-selection-test',
    getAccountStateIndex: () => ({
      getAccountState(accountRef) {
        return {
          accountRef,
          status: 'up',
          configured: true,
          apiKeyMode: false,
          runtimeState: runtime[accountRef] || null
        };
      }
    }),
    checkStatus: () => ({ configured: true, accountName: 'tester' }),
    accountStateService: { syncAccountBaseState: () => true },
    refreshIndexedStateForAccount: (provider, accountRef) => derived[accountRef] || {
      status: 'up',
      configured: true,
      apiKeyMode: false,
      remainingPct: 50,
      quotaStatus: 'available',
      schedulableStatus: 'schedulable',
      schedulableReason: ''
    },
    readServerConfig: () => ({}),
    readModelCatalog: () => input.modelCatalog || null,
    readCredentialRecord: (accountRef) => ({
      provider: accountRef.startsWith('acct_cn') ? 'codebuddycn' : 'codebuddy',
      env: {}
    }),
    listCliAccountRecords: (provider) => records[provider] || [],
    resolveAccountByCliId: (provider, cliAccountId) => (records[provider] || [])
      .find((record) => record.cliAccountId === String(cliAccountId)) || null
  });
  return service;
}

test('picks the healthy account with the most remaining quota', () => {
  const service = createService({
    records: {
      codebuddy: [
        { provider: 'codebuddy', accountRef: ref(1), cliAccountId: '1' },
        { provider: 'codebuddy', accountRef: ref(2), cliAccountId: '2' }
      ]
    },
    derived: {
      [ref(1)]: { remainingPct: 20, schedulableStatus: 'schedulable' },
      [ref(2)]: { remainingPct: 80, schedulableStatus: 'schedulable' }
    }
  });
  const target = service.getNextHealthyAccount('codebuddy', '1');
  assert.equal(target.cliAccountId, '2');
  assert.equal(target.remainingPct, 80);
});

test('rate-limited accounts are skipped, even with the most quota', () => {
  const service = createService({
    records: {
      codebuddy: [
        { provider: 'codebuddy', accountRef: ref(1), cliAccountId: '1' },
        { provider: 'codebuddy', accountRef: ref(2), cliAccountId: '2' }
      ]
    },
    derived: {
      [ref(1)]: { remainingPct: 95, schedulableStatus: 'schedulable' },
      [ref(2)]: { remainingPct: 30, schedulableStatus: 'schedulable' }
    },
    runtime: {
      [ref(1)]: { rateLimitUntil: Date.now() + 60000 }
    }
  });
  const target = service.getNextHealthyAccount('codebuddy', '');
  assert.equal(target.cliAccountId, '2');
});

test('a specified model prefers an account whose catalog lists it', () => {
  const service = createService({
    records: {
      codebuddy: [
        { provider: 'codebuddy', accountRef: ref(1), cliAccountId: '1' },
        { provider: 'codebuddy', accountRef: ref(2), cliAccountId: '2' }
      ]
    },
    derived: {
      [ref(1)]: { remainingPct: 90, schedulableStatus: 'schedulable' },
      [ref(2)]: { remainingPct: 10, schedulableStatus: 'schedulable' }
    },
    modelCatalog: {
      byAccount: {
        [ref(1)]: ['gpt-5.6'],
        [ref(2)]: ['glm-5.3']
      },
      incompleteByAccount: {}
    }
  });
  const target = service.getNextHealthyAccount('codebuddy', '', { model: 'glm-5.3' });
  assert.equal(target.cliAccountId, '2');
});

test('family mode can switch to the other CodeBuddy site', () => {
  const cnRef = 'acct_cn00000000000000001';
  const service = createService({
    records: {
      codebuddy: [{ provider: 'codebuddy', accountRef: ref(1), cliAccountId: '1' }],
      codebuddycn: [{ provider: 'codebuddycn', accountRef: cnRef, cliAccountId: '2' }]
    },
    derived: {
      [ref(1)]: { remainingPct: 10, schedulableStatus: 'schedulable' },
      [cnRef]: { remainingPct: 90, schedulableStatus: 'schedulable' }
    }
  });
  const target = service.getNextHealthyAccount('codebuddy', '1', { family: true });
  assert.equal(target.provider, 'codebuddycn');
  assert.equal(target.cliAccountId, '2');
});

test('family mode is opt-in: the legacy id lookup stays inside one provider', () => {
  const cnRef = 'acct_cn00000000000000001';
  const service = createService({
    records: {
      codebuddy: [{ provider: 'codebuddy', accountRef: ref(1), cliAccountId: '1' }],
      codebuddycn: [{ provider: 'codebuddycn', accountRef: cnRef, cliAccountId: '2' }]
    },
    derived: {
      [ref(1)]: { remainingPct: 10, schedulableStatus: 'schedulable' },
      [cnRef]: { remainingPct: 90, schedulableStatus: 'schedulable' }
    }
  });
  assert.equal(service.getNextAvailableId('codebuddy', '1'), null);
});

test('no healthy account returns null instead of a disabled one', () => {
  const service = createService({
    records: {
      codebuddy: [
        { provider: 'codebuddy', accountRef: ref(1), cliAccountId: '1' },
        { provider: 'codebuddy', accountRef: ref(2), cliAccountId: '2' }
      ]
    },
    derived: {
      [ref(1)]: { remainingPct: 0, schedulableStatus: 'blocked_by_quota' },
      [ref(2)]: { remainingPct: 1, schedulableStatus: 'blocked_by_policy' }
    }
  });
  assert.equal(service.getNextHealthyAccount('codebuddy', '1'), null);
});
test('family 选号优先当前站点，再考虑跨站高额度', () => {
  const service = createService({
    records: {
      codebuddy: [
        { provider: 'codebuddy', accountRef: ref(1), cliAccountId: '1' }
      ],
      codebuddycn: [
        { provider: 'codebuddycn', accountRef: 'acct_cn' + '0'.repeat(17) + '2', cliAccountId: '2' }
      ]
    },
    derived: {
      [ref(1)]: { remainingPct: 100, schedulableStatus: 'schedulable' },
      ['acct_cn' + '0'.repeat(17) + '2']: { remainingPct: 70, schedulableStatus: 'schedulable' }
    }
  });
  const target = service.getNextHealthyAccount('codebuddycn', '', { family: true });
  assert.equal(target.provider, 'codebuddycn');
  assert.equal(target.cliAccountId, '2');
});
