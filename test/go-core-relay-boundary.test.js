'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { explainGoRouteDeferral } = require('../lib/server/go-core-route-deferral');
const { NODE_FALLBACK_REASONS } = require('../lib/server/go-core-node-fallback-counters');

const ACCOUNT_REF = 'acct_c016fd7eee0f64163068';
const MODEL = 'gpt-6.1-sol';
const ENTRY = 'gateway.openai.responses';

function customRelayAccount() {
  return {
    accountRef: ACCOUNT_REF,
    provider: 'codex',
    apiKeyMode: true,
    baseUrl: 'http://54.178.88.80:9527/v1',
    status: 'up'
  };
}

function explainPinnedRelay() {
  const account = customRelayAccount();
  return explainGoRouteDeferral({
    entryId: ENTRY,
    model: MODEL,
    pinnedAccountRef: ACCOUNT_REF,
    state: {
      accounts: { codex: [account] }
    },
    egressBoundRefs: () => new Set(),
    goAcceptedErrorRuleRefs: () => new Set(),
    goRoutableModelIds: () => new Set([MODEL])
  });
}

function explainPinnedRelayWithStaleRuntimeBlock() {
  const account = { ...customRelayAccount(), runtimeStatus: 'rate_limited' };
  return explainGoRouteDeferral({
    entryId: ENTRY,
    model: MODEL,
    pinnedAccountRef: ACCOUNT_REF,
    state: { accounts: { codex: [account] } },
    accountStateIndex: {
      getAccountState: () => ({ status: 'up' })
    },
    egressBoundRefs: () => new Set(),
    goAcceptedErrorRuleRefs: () => new Set(),
    goRoutableModelIds: () => new Set([MODEL])
  });
}

function explainUnpinnedRelay() {
  const account = customRelayAccount();
  return explainGoRouteDeferral({
    entryId: ENTRY,
    model: MODEL,
    state: {
      accounts: { codex: [account] }
    },
    egressBoundRefs: () => new Set(),
    goAcceptedErrorRuleRefs: () => new Set(),
    goRoutableModelIds: () => new Set([MODEL])
  });
}

function explainPinnedOfficialApiKey() {
  return explainGoRouteDeferral({
    entryId: ENTRY,
    model: MODEL,
    pinnedAccountRef: ACCOUNT_REF,
    state: {
      accounts: {
        codex: [{
          accountRef: ACCOUNT_REF,
          provider: 'codex',
          apiKeyMode: true,
          baseUrl: 'https://api.openai.com/v1',
          status: 'up'
        }]
      }
    },
    egressBoundRefs: () => new Set(),
    goAcceptedErrorRuleRefs: () => new Set(),
    goRoutableModelIds: () => new Set([MODEL])
  });
}

test('custom remote upstream accounts stay on Node instead of Go native quota state', () => {
  const decision = explainPinnedRelay();

  assert.deepEqual(decision, {
    defer: true,
    reason: 'custom_upstream_node_only'
  });
});

test('a stale Go quota overlay cannot make a custom relay pin unusable before Node handles it', () => {
  assert.deepEqual(explainPinnedRelayWithStaleRuntimeBlock(), {
    defer: true,
    reason: 'custom_upstream_node_only'
  });
});

test('an unpinned pool containing a custom remote upstream also stays on Node', () => {
  const decision = explainUnpinnedRelay();

  assert.deepEqual(decision, {
    defer: true,
    reason: 'custom_upstream_node_only'
  });
});

test('an official API key account keeps the existing Go route', () => {
  assert.deepEqual(explainPinnedOfficialApiKey(), {
    defer: false,
    reason: ''
  });
});

test('custom upstream deferral is a stable readyz fallback reason', () => {
  assert.ok(NODE_FALLBACK_REASONS.includes('custom_upstream_node_only'));
});
