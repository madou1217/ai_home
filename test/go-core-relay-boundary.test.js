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

function explainUnpinnedRelay(routableModels = [MODEL]) {
  const account = customRelayAccount();
  return explainGoRouteDeferral({
    entryId: ENTRY,
    model: MODEL,
    state: {
      accounts: { codex: [account] }
    },
    egressBoundRefs: () => new Set(),
    goAcceptedErrorRuleRefs: () => new Set(),
    goRoutableModelIds: () => new Set(routableModels)
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

// 池级判定已删除：自定义上游账号改由 Go 的路由排除（go-account-sync 按账号推送）
// 保证不会被选中，同池里的官方账号因此能正常交给 Go —— 这正是用量账本长期为空的解药。
test('an unpinned pool of custom remote upstream accounts no longer blocks the Go route', () => {
  assert.deepEqual(explainUnpinnedRelay(), {
    defer: false,
    reason: ''
  });
});

// 剩下的兜底在模型目录上：Go 不列出被排除账号承载的模型，这类请求仍交还 Node。
test('a model only carried by excluded custom upstream accounts still falls back on model_not_routable', () => {
  assert.deepEqual(explainUnpinnedRelay([]), {
    defer: true,
    reason: 'model_not_routable'
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

// 生图入口：Go 有独立的完整实现，池门判据换成「承载者都有 Go 的图片实现」。
// 旧口径下这两个用例都会交还 Node（pool_has_non_go_servable_provider），
// 结果就是 /v1/images/* 在真机上永远走不到 Go（2026-11-01 实测：Go 进程全程没有上游连接）。
const IMAGE_ENTRY = 'gateway.images.generations';
const IMAGE_MODEL = 'gpt-image-2';

function imageDeferralInput(carrierProviders) {
  const accountByRef = new Map();
  const refs = [];
  carrierProviders.forEach((provider, index) => {
    const ref = `acct_image_${index}`;
    refs.push(ref);
    accountByRef.set(ref, { accountRef: ref, provider });
  });
  return {
    entryId: IMAGE_ENTRY,
    model: IMAGE_MODEL,
    state: {
      accounts: {
        codex: [customRelayAccount()],
        // 池里还有没有图片实现的 Provider —— 推理池门会因此整体交还 Node。
        kiro: [{ accountRef: 'acct_kiro', provider: 'kiro', status: 'up' }]
      },
      modelAccountIndex: {
        builtAt: 1,
        modelToAccounts: new Map([[IMAGE_MODEL, refs]]),
        accountByRef
      }
    },
    egressBoundRefs: () => new Set(),
    goAcceptedErrorRuleRefs: () => new Set()
  };
}

test('an unpinned image request keeps the Go route even when the pool has a custom relay', () => {
  assert.deepEqual(explainGoRouteDeferral(imageDeferralInput(['codex'])), {
    defer: false,
    reason: ''
  });
});

test('an image request whose carrier has no Go image implementation still stays on Node', () => {
  assert.deepEqual(explainGoRouteDeferral(imageDeferralInput(['kiro'])), {
    defer: true,
    reason: 'pool_has_non_go_servable_provider'
  });
});

