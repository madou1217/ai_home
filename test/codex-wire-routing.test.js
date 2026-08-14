'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildModelAccountIndex } = require('../lib/server/model-account-index');
const {
  resolveCodexWireApiCandidates,
  shouldRouteCodexViaChatCompletions
} = require('../lib/server/codex-wire-routing');

const RELAY_REF = 'acct_abc300165312ecfab1ff';
const OFFICIAL_REF = 'acct_1111111111111111aaaa';

const relayAccount = {
  accountRef: RELAY_REF,
  apiKeyMode: true,
  // The probe-derived index only considers accounts holding a usable credential.
  accessToken: 'sk-relay-test',
  openaiBaseUrl: 'https://api.cline.bot/api/v1',
  upstreamWireApi: 'chat',
  upstreamHeaders: { 'x-client-type': 'cline-cli' }
};

const officialAccount = {
  accountRef: OFFICIAL_REF,
  openaiBaseUrl: 'https://chatgpt.com/backend-api/codex'
};

// A chat-wire relay that needs no vendor headers at all (ollama cloud): the
// wire API alone must be enough to divert routing.
const HEADERLESS_RELAY_REF = 'acct_52facbdf93d7161b990d';
const headerlessRelayAccount = {
  accountRef: HEADERLESS_RELAY_REF,
  apiKeyMode: true,
  accessToken: 'sk-headerless-test',
  openaiBaseUrl: 'https://ollama.com/v1',
  upstreamWireApi: 'chat'
};

function manualSetting(accountRef, id) {
  return { id, provider: 'codex', accountRef, manual: true, enabled: true };
}

function makeState(overrides = {}) {
  return {
    accounts: { codex: [relayAccount, officialAccount] },
    modelCatalogSettings: {
      accountModels: [
        manualSetting(RELAY_REF, 'cline-free/glm-5.2'),
        manualSetting(RELAY_REF, 'deepseek/deepseek-v4-flash')
      ]
    },
    ...overrides
  };
}

test('routes a relay-bound model to chat/completions via its manual catalog binding', () => {
  const state = makeState();
  ['cline-free/glm-5.2', 'deepseek/deepseek-v4-flash'].forEach((model) => {
    assert.equal(
      shouldRouteCodexViaChatCompletions({ state, requestJson: { model } }),
      true,
      `expected ${model} to route via chat/completions`
    );
  });
});

test('routes a header-free chat-wire relay via chat/completions too', () => {
  const state = makeState({
    accounts: { codex: [headerlessRelayAccount, officialAccount] },
    modelCatalogSettings: {
      accountModels: [
        manualSetting(HEADERLESS_RELAY_REF, 'gpt-oss:120b'),
        // Disabled because the plan does not include it: it must not narrow the
        // pool onto this relay, so routing stays on the default adapter.
        { ...manualSetting(HEADERLESS_RELAY_REF, 'qwen3.5:397b'), enabled: false }
      ]
    }
  });
  assert.equal(shouldRouteCodexViaChatCompletions({
    state,
    requestJson: { model: 'gpt-oss:120b' }
  }), true);
  assert.equal(shouldRouteCodexViaChatCompletions({
    state,
    requestJson: { model: 'qwen3.5:397b' }
  }), false);
  // An explicit pin still reaches the relay, which is how a disabled model can
  // still be attempted on purpose.
  assert.equal(shouldRouteCodexViaChatCompletions({
    state,
    requestJson: { model: 'qwen3.5:397b' },
    requestedAccountRef: HEADERLESS_RELAY_REF
  }), true);
});

test('keeps ordinary codex models on the Responses adapter', () => {
  const state = makeState();
  ['gpt-5.6', 'gpt-5.6-codex', 'o3'].forEach((model) => {
    assert.equal(
      shouldRouteCodexViaChatCompletions({ state, requestJson: { model } }),
      false,
      `expected ${model} to stay on Responses`
    );
  });
});

test('an explicit account pin decides on its own, without model narrowing', () => {
  const state = makeState();
  assert.equal(shouldRouteCodexViaChatCompletions({
    state,
    requestJson: { model: 'gpt-5.6' },
    requestedAccountRef: RELAY_REF
  }), true);
  assert.equal(shouldRouteCodexViaChatCompletions({
    state,
    requestJson: { model: 'cline-free/glm-5.2' },
    requestedAccountRef: OFFICIAL_REF
  }), false);
});

test('an unknown account pin yields no candidates and keeps existing behaviour', () => {
  const state = makeState();
  assert.deepEqual(resolveCodexWireApiCandidates({
    state,
    requestJson: { model: 'cline-free/glm-5.2' },
    requestedAccountRef: 'acct_deadbeefdeadbeefdead'
  }), []);
  assert.equal(shouldRouteCodexViaChatCompletions({
    state,
    requestJson: { model: 'cline-free/glm-5.2' },
    requestedAccountRef: 'acct_deadbeefdeadbeefdead'
  }), false);
});

test('a mixed candidate pool falls back to Responses rather than switching protocol', () => {
  // Same model bound to both a chat-wire relay and a Responses account.
  const state = makeState({
    modelCatalogSettings: {
      accountModels: [
        manualSetting(RELAY_REF, 'shared-model'),
        manualSetting(OFFICIAL_REF, 'shared-model')
      ]
    }
  });
  assert.equal(resolveCodexWireApiCandidates({ state, requestJson: { model: 'shared-model' } }).length, 2);
  assert.equal(shouldRouteCodexViaChatCompletions({ state, requestJson: { model: 'shared-model' } }), false);
});

test('a manual binding pointing at no live account does not narrow the pool', () => {
  const state = makeState({
    modelCatalogSettings: {
      accountModels: [manualSetting('acct_0000000000000000beef', 'cline-free/glm-5.2')]
    }
  });
  assert.equal(shouldRouteCodexViaChatCompletions({
    state,
    requestJson: { model: 'cline-free/glm-5.2' }
  }), false);
});

test('a disabled manual binding is ignored', () => {
  const state = makeState({
    modelCatalogSettings: {
      accountModels: [{ ...manualSetting(RELAY_REF, 'cline-free/glm-5.2'), enabled: false }]
    }
  });
  assert.equal(shouldRouteCodexViaChatCompletions({
    state,
    requestJson: { model: 'cline-free/glm-5.2' }
  }), false);
});

test('a manual binding owned by another provider is ignored', () => {
  const state = makeState({
    modelCatalogSettings: {
      accountModels: [{ ...manualSetting(RELAY_REF, 'cline-free/glm-5.2'), provider: 'claude' }]
    }
  });
  assert.equal(shouldRouteCodexViaChatCompletions({
    state,
    requestJson: { model: 'cline-free/glm-5.2' }
  }), false);
});

test('falls back to the probe-derived index when no manual binding exists', () => {
  const base = makeState({ modelCatalogSettings: { accountModels: [] } });
  base.webUiModelsCache = {
    byAccount: { [RELAY_REF]: ['probe-only-model'] }
  };
  base.modelAccountIndex = buildModelAccountIndex(base, {});
  assert.equal(shouldRouteCodexViaChatCompletions({
    state: base,
    requestJson: { model: 'probe-only-model' }
  }), true);
});

test('an empty or absent codex pool never diverts routing', () => {
  [
    {},
    { accounts: {} },
    { accounts: { codex: [] } },
    { accounts: { codex: [officialAccount] } }
  ].forEach((state) => {
    assert.equal(shouldRouteCodexViaChatCompletions({
      state,
      requestJson: { model: 'cline-free/glm-5.2' }
    }), false);
  });
});

test('a request without a model keeps the existing adapter unless the whole pool agrees', () => {
  const state = makeState();
  assert.equal(shouldRouteCodexViaChatCompletions({ state, requestJson: {} }), false);
  const relayOnly = makeState({ accounts: { codex: [relayAccount] } });
  assert.equal(shouldRouteCodexViaChatCompletions({ state: relayOnly, requestJson: {} }), true);
});

// 目录已知且明确不含请求模型的中转账号，不得参与 wire api 的一致性表决。
// 现场是 ollama（目录里只有开源模型）被算进候选，去左右 gpt-5.6-luna 该走哪套协议。
test('a relay whose catalog is known to lack the model is not counted as a wire candidate', () => {
  const state = {
    accounts: { codex: [headerlessRelayAccount, officialAccount] },
    modelCatalogSettings: { accountModels: [] },
    webUiModelsCache: {
      updatedAt: Date.now(),
      byAccount: {
        // ollama 中转：只有开源模型，没有 luna。
        [HEADERLESS_RELAY_REF]: ['kimi-k3', 'qwen3.5:397b', 'glm-5.2'],
        // 官方账号有 luna，但此刻不可调度（无 accessToken → 不进 routable 列表），
        // 于是倒排索引查不到绑定，逻辑落到「整池放行」那条分支。
        [OFFICIAL_REF]: ['gpt-5.6-luna']
      },
      byProvider: {}
    }
  };
  state.modelAccountIndex = buildModelAccountIndex(state, {});

  const candidates = resolveCodexWireApiCandidates({
    state,
    requestJson: { model: 'gpt-5.6-luna' }
  });
  assert.equal(
    candidates.some((account) => account.accountRef === HEADERLESS_RELAY_REF),
    false,
    'ollama must not vote on the wire api for a model it does not have'
  );
  assert.equal(shouldRouteCodexViaChatCompletions({
    state,
    requestJson: { model: 'gpt-5.6-luna' }
  }), false);
});
