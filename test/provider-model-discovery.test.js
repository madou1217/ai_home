const test = require('node:test');
const assert = require('node:assert/strict');
const {
  discoverProviderModels,
  buildModelDiscoverySignature
} = require('../lib/server/provider-model-discovery');

const AGY_ACCOUNT_REF = 'acct_0123456789abcdefabcd';
const CODEX_OAUTH_REF = 'acct_11111111111111111111';
const CODEX_API_REF = 'acct_22222222222222222222';
const GEMINI_ACCOUNT_REF = 'acct_33333333333333333333';
const OPENCODE_ACCOUNT_REF = 'acct_44444444444444444444';
const CLAUDE_AUTH_TOKEN_REF = 'acct_55555555555555555555';

test('provider model discovery filters internal enum ids from remote catalogs', async () => {
  const state = {
    accounts: {
      codex: [],
      gemini: [],
      claude: [],
      agy: [{
        id: 'a1',
        accountRef: AGY_ACCOUNT_REF,
        provider: 'agy',
        accessToken: 'agy-token'
      }]
    },
    modelRegistry: {
      providers: {}
    }
  };

  const discovery = await discoverProviderModels({
    state,
    options: { provider: 'agy' },
    providerMode: 'agy',
    includeCodex: false,
    fetchModelsForAccount: async () => [
      'MODEL_INTERNAL_ALPHA',
      'chat_20706',
      'models/proactive-observer',
      'catalog-public-model'
    ]
  });

  assert.deepEqual(discovery.byProvider.agy, ['catalog-public-model']);
  assert.deepEqual(discovery.byAccount[AGY_ACCOUNT_REF], ['catalog-public-model']);
  assert.deepEqual(discovery.ids, ['catalog-public-model']);
});

test('provider model discovery probes codex api-key and oauth accounts', async () => {
  const seenAccounts = [];
  const state = {
    accounts: {
      codex: [
        {
          id: 'oauth-1',
          accountRef: CODEX_OAUTH_REF,
          provider: 'codex',
          accessToken: 'oauth-token',
          authType: 'oauth'
        },
        {
          id: 'api-1',
          accountRef: CODEX_API_REF,
          provider: 'codex',
          accessToken: 'sk-live',
          apiKeyMode: true,
          authType: 'api-key',
          openaiBaseUrl: 'https://relay.example.com/v1'
        }
      ],
      gemini: [],
      claude: [],
      agy: []
    },
    modelRegistry: {
      providers: {
        codex: new Set()
      }
    }
  };

  const discovery = await discoverProviderModels({
    state,
    options: { provider: 'auto' },
    providerMode: 'auto',
    includeCodex: true,
    includeAccountModels: true,
    accountLimit: 8,
    fetchModelsForAccount: async (_options, account) => {
      seenAccounts.push(account.id);
      return account.id === 'oauth-1' ? ['gpt-5.3-codex'] : ['gpt-5.4'];
    }
  });

  assert.deepEqual(seenAccounts, ['oauth-1', 'api-1']);
  assert.deepEqual(discovery.byAccount[CODEX_OAUTH_REF], ['gpt-5.3-codex']);
  assert.deepEqual(discovery.byAccount[CODEX_API_REF], ['gpt-5.4']);
  assert.deepEqual(discovery.byProvider.codex, ['gpt-5.3-codex', 'gpt-5.4']);
});

test('provider model discovery probes claude auth-token proxies but ignores their local model snapshots', async () => {
  // 现行意图(shouldProbeAccountModels / fetchModelsForAccount 注释):claude auth-token 是第三方
  // Anthropic 协议代理(GLM/DeepSeek/JD…),【参与远程探测】拿真实模型;但其【本地 availableModels
  // 快照】('opus[1m]')不被采纳/泄漏(collectAccountLocalModels 对 claude auth-token 返 [])。
  let probed = false;
  const state = {
    accounts: {
      codex: [],
      gemini: [],
      claude: [{
        id: '6',
        accountRef: CLAUDE_AUTH_TOKEN_REF,
        provider: 'claude',
        accessToken: 'sk-auth-token',
        apiKeyMode: true,
        authMode: 'auth-token',
        availableModels: ['opus[1m]']
      }],
      agy: []
    },
    modelRegistry: {
      providers: {}
    }
  };

  const discovery = await discoverProviderModels({
    state,
    options: { provider: 'claude' },
    providerMode: 'claude',
    includeAccountModels: true,
    accountLimit: 8,
    fetchModelsForAccount: async () => {
      probed = true;
      return ['claude-sonnet-4-6'];
    }
  });

  assert.equal(probed, true);
  assert.deepEqual(discovery.byAccount[CLAUDE_AUTH_TOKEN_REF], ['claude-sonnet-4-6']);
  // 本地快照 'opus[1m]' 不得泄漏进结果
  assert.ok(!(discovery.byProvider.claude || []).includes('opus[1m]'));
  assert.equal(discovery.firstError, '');
});

test('provider model discovery probes codex oauth for forced scoped refresh', async () => {
  const seenAccounts = [];
  const state = {
    accounts: {
      codex: [{
        id: 'oauth-1',
        accountRef: CODEX_OAUTH_REF,
        provider: 'codex',
        accessToken: 'oauth-token',
        authType: 'oauth',
        uniqueKey: 'oauth:codex:stable'
      }],
      gemini: [],
      claude: [],
      agy: []
    },
    modelRegistry: {
      providers: {
        codex: new Set(['gpt-5.4', 'MODEL_INTERNAL_ALPHA'])
      }
    }
  };

  const discovery = await discoverProviderModels({
    state,
    options: { provider: 'auto', codexModels: 'gpt-5.5' },
    providerMode: 'auto',
    includeCodex: true,
    includeAccountModels: true,
    accountScope: { accountRef: CODEX_OAUTH_REF },
    accountLimit: 8,
    probeCodex: true,
    fetchModelsForAccount: async (_options, account) => {
      seenAccounts.push(account.id);
      return ['gpt-5.6-codex'];
    }
  });

  assert.deepEqual(seenAccounts, ['oauth-1']);
  assert.deepEqual(discovery.byAccount[CODEX_OAUTH_REF], ['gpt-5.6-codex']);
  assert.deepEqual(discovery.byProvider.codex, ['gpt-5.6-codex']);
  assert.equal(discovery.firstError, '');
  assert.equal(discovery.source, 'remote');
  assert.equal(discovery.scannedAccounts, 1);
  assert.deepEqual(discovery.errorsByAccount, {});
});

test('provider model discovery treats empty codex oauth native catalog as a probe error', async () => {
  const seenAccounts = [];
  const state = {
    accounts: {
      codex: [{
        id: 'oauth-1',
        accountRef: CODEX_OAUTH_REF,
        provider: 'codex',
        accessToken: 'oauth-token',
        authType: 'oauth',
        uniqueKey: 'oauth:codex:stable'
      }],
      gemini: [],
      claude: [],
      agy: []
    },
    webUiModelsCache: {
      byProvider: {
        codex: ['claude-provider-cache-must-not-leak']
      }
    },
    modelRegistry: {
      providers: {
        codex: new Set()
      }
    }
  };

  const discovery = await discoverProviderModels({
    state,
    options: { provider: 'auto' },
    providerMode: 'auto',
    includeCodex: true,
    includeAccountModels: true,
    accountScope: { accountRef: CODEX_OAUTH_REF },
    accountLimit: 8,
    fetchModelsForAccount: async (_options, account) => {
      seenAccounts.push(account.id);
      return [];
    }
  });

  assert.deepEqual(seenAccounts, ['oauth-1']);
  assert.deepEqual(discovery.byAccount[CODEX_OAUTH_REF], []);
  assert.equal(discovery.errorsByAccount[CODEX_OAUTH_REF], 'empty_codex_models_catalog');
  assert.equal(discovery.firstError, 'empty_codex_models_catalog');
  assert.equal(discovery.source, 'error');
  assert.equal(discovery.scannedAccounts, 1);
});

test('provider model discovery treats empty codex API-KEY catalog as a probe error (preserves last-known binding)', async () => {
  // 回归:api-key codex(如 yesboss 转售端点)一次返回空 /models 必须记为【探测失败】(errorsByAccount),
  // 而不是"信任空结果"把 byAccount 写成 []。否则 mergeByAccountCache 会把 gpt-5.5→codex 的绑定抹掉 →
  // countAvailableAccountsForModel=0 → "no available codex account" 503(codex-1 探测后掉出路由的根因)。
  const seenAccounts = [];
  const state = {
    accounts: {
      codex: [{
        id: 'apikey-1',
        accountRef: CODEX_API_REF,
        provider: 'codex',
        accessToken: 'sk-yesboss',
        apiKeyMode: true,
        authType: 'api-key',
        uniqueKey: 'apikey:codex:yesboss'
      }],
      gemini: [],
      claude: [],
      agy: []
    },
    modelRegistry: { providers: { codex: new Set() } }
  };

  const discovery = await discoverProviderModels({
    state,
    options: { provider: 'auto' },
    providerMode: 'auto',
    includeCodex: true,
    includeAccountModels: true,
    accountScope: { accountRef: CODEX_API_REF },
    accountLimit: 8,
    fetchModelsForAccount: async (_options, account) => {
      seenAccounts.push(account.id);
      return [];
    }
  });

  assert.deepEqual(seenAccounts, ['apikey-1']);
  assert.equal(discovery.errorsByAccount[CODEX_API_REF], 'empty_codex_models_catalog');
  assert.equal(discovery.firstError, 'empty_codex_models_catalog');
});

test('provider model discovery uses the normal probe timeout for OpenCode Go API', async () => {
  const seenTimeouts = [];
  const state = {
    accounts: {
      opencode: [{
        id: '1',
        accountRef: OPENCODE_ACCOUNT_REF,
        provider: 'opencode',
        accessToken: 'opencode-local',
        authType: 'opencode-auth'
      }]
    },
    modelRegistry: {
      providers: {
        opencode: new Set()
      }
    }
  };

  const discovery = await discoverProviderModels({
    state,
    options: { provider: 'opencode' },
    providerMode: 'opencode',
    includeCodex: true,
    includeAccountModels: true,
    accountLimit: 1,
    timeoutMs: 8000,
    fetchModelsForAccount: async (_options, _account, timeoutMs) => {
      seenTimeouts.push(timeoutMs);
      return ['opencode-go/glm-5.2'];
    }
  });

  assert.deepEqual(seenTimeouts, [8000]);
  assert.equal(discovery.scannedAccounts, 1);
  assert.deepEqual(discovery.byAccount[OPENCODE_ACCOUNT_REF], ['opencode-go/glm-5.2']);
});

test('provider model discovery signatures use accountRef instead of mutable ids', async () => {
  const base = {
    accountRef: GEMINI_ACCOUNT_REF,
    provider: 'gemini',
    accessToken: 'token',
    uniqueKey: 'oauth:gemini:user@example.com'
  };
  const stateA = {
    accounts: {
      gemini: [{ ...base, id: 'old-id', availableModels: ['gemini-old-local'] }]
    },
    modelRegistry: { providers: { gemini: new Set() } }
  };
  const stateB = {
    accounts: {
      gemini: [{ ...base, id: 'new-id', availableModels: ['gemini-new-local'] }]
    },
    modelRegistry: { providers: { gemini: new Set() } }
  };

  const signatureA = buildModelDiscoverySignature(stateA, {
    providerMode: 'gemini',
    includeAccountModels: true
  });
  const signatureB = buildModelDiscoverySignature(stateB, {
    providerMode: 'gemini',
    includeAccountModels: true
  });

  assert.equal(signatureA, signatureB);

  const discovery = await discoverProviderModels({
    state: stateA,
    providerMode: 'gemini',
    includeAccountModels: true,
    fetchModelsForAccount: async () => ['gemini-2.5-pro']
  });

  assert.deepEqual(discovery.byAccount[GEMINI_ACCOUNT_REF], ['gemini-2.5-pro']);
});

test('provider model discovery signatures ignore internal enum ids', () => {
  const signature = buildModelDiscoverySignature({
    accounts: {
      agy: [{
        id: 'a1',
        accountRef: AGY_ACCOUNT_REF,
        provider: 'agy',
        availableModels: ['MODEL_INTERNAL_ALPHA', 'chat_20706', 'models/proactive-observer', 'catalog-public-model']
      }]
    },
    modelRegistry: {
      providers: {
        agy: new Set(['MODEL_INTERNAL_BETA', 'models/proactive-observer', 'registry-public-model'])
      }
    }
  }, {
    providerMode: 'agy',
    includeAccountModels: true
  });

  assert.equal(signature, `agy:r=registry-public-model:a=${AGY_ACCOUNT_REF}[oauth:no-token]`);
});
