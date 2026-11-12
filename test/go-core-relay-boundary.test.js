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

// relay 通道（codebuddy 等）的自定义上游：端点写死在发行版里，Go 不能忠实转发。
function explainPinnedRelayChannel() {
  const account = {
    accountRef: ACCOUNT_REF,
    provider: 'codebuddy',
    apiKeyMode: true,
    baseUrl: 'http://relay.example.com/v1',
    status: 'up'
  };
  return explainGoRouteDeferral({
    entryId: 'gateway.openai.chat_completions',
    model: 'DeepSeek-V4-Pro',
    pinnedAccountRef: ACCOUNT_REF,
    state: { accounts: { codebuddy: [account] } },
    egressBoundRefs: () => new Set(),
    goAcceptedErrorRuleRefs: () => new Set(),
    goRoutableModelIds: () => new Set(['DeepSeek-V4-Pro'])
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

test('canonical 通道的自定义上游钉选交给 Go（适配器用账号自己的 base_url）', () => {
  assert.deepEqual(explainPinnedRelay(), {
    defer: false,
    reason: ''
  });
});

test('陈旧的 Go 运行态叠加层不会让 canonical 钉选被判不可用', () => {
  assert.deepEqual(explainPinnedRelayWithStaleRuntimeBlock(), {
    defer: false,
    reason: ''
  });
});

test('relay 通道的自定义上游钉选仍留在 Node（端点硬编码）', () => {
  assert.deepEqual(explainPinnedRelayChannel(), {
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


// 池门（模型级收窄）：池里存在 Go 服务不了的 Provider（gemini）时，判据是
// 「这个模型的承载者是否全都能被 Go 服务」，不再要求「全为 relay 通道」。
// 旧口径会让 claude / codex / agy 的 canonical 模型在池里有 gemini 账号时全部留在 Node
// （2026-11-06 真机：claude 请求不增长 usage_ledger）。
const CHAT_ENTRY = 'gateway.openai.chat_completions';

function chatDeferralInput(carrierProviders) {
  const accountByRef = new Map();
  const refs = [];
  carrierProviders.forEach((provider, index) => {
    const ref = 'acct_chat_' + index;
    refs.push(ref);
    accountByRef.set(ref, { accountRef: ref, provider });
  });
  return {
    entryId: CHAT_ENTRY,
    model: 'claude-sonnet-4-6',
    state: {
      accounts: {
        claude: [{ accountRef: 'acct_claude', provider: 'claude', status: 'up' }],
        gemini: [{ accountRef: 'acct_gemini', provider: 'gemini', status: 'up' }]
      },
      modelAccountIndex: {
        builtAt: 1,
        modelToAccounts: new Map([['claude-sonnet-4-6', refs]]),
        accountByRef
      }
    },
    egressBoundRefs: () => new Set(),
    goAcceptedErrorRuleRefs: () => new Set()
  };
}

test('canonical 模型只由 Go 能服务的 Provider 承载时继续交给 Go（池里有 gemini 也放行）', () => {
  assert.deepEqual(explainGoRouteDeferral(chatDeferralInput(['claude'])), {
    defer: false,
    reason: ''
  });
});

test('模型承载者包含 Go 服务不了的 Provider 时仍交还 Node', () => {
  assert.deepEqual(explainGoRouteDeferral(chatDeferralInput(['claude', 'gemini'])), {
    defer: true,
    reason: 'pool_has_non_go_servable_provider'
  });
});
