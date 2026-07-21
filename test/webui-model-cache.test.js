const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  getWebUiModelsCache,
  invalidateWebUiModelsCache,
  invalidateWebUiModelsCacheAccountRefs
} = require('../lib/server/webui-model-cache');
const { getAppStateDbPath } = require('../lib/server/app-state-store');

const AGY_ACCOUNT_REF = 'acct_0123456789abcdefabcd';
const GEMINI_ACCOUNT_REF = 'acct_11111111111111111111';
const CODEX_ACCOUNT_REF = 'acct_22222222222222222222';
const OPENCODE_ACCOUNT_REF = 'acct_33333333333333333333';

test('webui model cache exposes upstream display labels collected from account descriptors', async () => {
  const account = {
    id: '1',
    accountRef: AGY_ACCOUNT_REF,
    provider: 'agy',
    accessToken: 'token',
    availableModels: []
  };
  const state = {
    accounts: { agy: [account] },
    modelRegistry: { providers: {} }
  };

  const result = await getWebUiModelsCache(state, { provider: 'auto' }, {
    forceRefresh: true,
    fetchModelsForAccount: async (_options, target) => {
      // 模拟探测时写回 descriptors(displayName 与 id 错位的真实场景)
      target.codeAssistModelDescriptors = [
        { id: 'gemini-3-flash-agent', displayName: 'Gemini 3.5 Flash (High)' },
        { id: 'gemini-3.5-flash-low', displayName: 'Gemini 3.5 Flash (Medium)' },
        { id: 'no-label-model', displayName: '' }
      ];
      return ['gemini-3-flash-agent', 'gemini-3.5-flash-low', 'no-label-model'];
    }
  });

  assert.deepEqual(result.models.agy, ['gemini-3-flash-agent', 'gemini-3.5-flash-low', 'no-label-model']);
  assert.deepEqual(result.labels.agy, {
    'gemini-3-flash-agent': 'Gemini 3.5 Flash (High)',
    'gemini-3.5-flash-low': 'Gemini 3.5 Flash (Medium)'
  });

  // 命中缓存的读取同样携带 labels
  const cached = await getWebUiModelsCache(state, { provider: 'auto' }, {
    fetchModelsForAccount: async () => {
      throw new Error('should not refetch within ttl');
    }
  });
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.labels.agy['gemini-3-flash-agent'], 'Gemini 3.5 Flash (High)');
});

test('webui model cache is persisted and reused without a fresh probe', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-model-cache-'));
  const account = {
    id: 'g1',
    accountRef: GEMINI_ACCOUNT_REF,
    provider: 'gemini',
    accessToken: 'token',
    uniqueKey: 'oauth:gemini:user@example.com'
  };
  const createState = () => ({
    accounts: { gemini: [{ ...account }] },
    modelRegistry: { providers: { gemini: new Set() } }
  });

  try {
    const first = await getWebUiModelsCache(createState(), { provider: 'auto' }, {
      forceRefresh: true,
      accountLimit: 0,
      fs,
      aiHomeDir,
      fetchModelsForAccount: async () => ['gemini-2.5-pro']
    });

    assert.equal(first.cached, false);
    assert.deepEqual(first.byAccount[GEMINI_ACCOUNT_REF], ['gemini-2.5-pro']);
    assert.equal(fs.existsSync(getAppStateDbPath(aiHomeDir)), true);

    const cached = await getWebUiModelsCache(createState(), { provider: 'auto' }, {
      accountLimit: 0,
      fs,
      aiHomeDir,
      fetchModelsForAccount: async () => {
        throw new Error('should not refetch persisted cache');
      }
    });

    assert.equal(cached.cached, true);
    assert.deepEqual(cached.byAccount[GEMINI_ACCOUNT_REF], ['gemini-2.5-pro']);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('webui model cache keeps stale models when a forced probe fails', async () => {
  const account = {
    id: 'g1',
    accountRef: GEMINI_ACCOUNT_REF,
    provider: 'gemini',
    accessToken: 'token',
    uniqueKey: 'oauth:gemini:user@example.com'
  };
  const state = {
    accounts: { gemini: [account] },
    modelRegistry: { providers: { gemini: new Set() } },
    webUiModelsCache: {
      updatedAt: Date.now(),
      byProvider: { gemini: ['gemini-2.5-pro'] },
      byAccount: {
        [GEMINI_ACCOUNT_REF]: ['gemini-2.5-pro']
      },
      errorsByAccount: {},
      labels: {},
      signature: '',
      source: 'remote',
      sourceCount: 1,
      scannedAccounts: 1,
      firstError: ''
    }
  };

  const result = await getWebUiModelsCache(state, { provider: 'auto' }, {
    forceRefresh: true,
    accountLimit: 0,
    fetchModelsForAccount: async () => {
      throw new Error('HTTP 503 upstream busy');
    }
  });

  assert.equal(result.cached, false);
  assert.deepEqual(result.models.gemini, ['gemini-2.5-pro']);
  assert.deepEqual(result.byAccount[GEMINI_ACCOUNT_REF], ['gemini-2.5-pro']);
  assert.match(result.errorsByAccount[GEMINI_ACCOUNT_REF], /HTTP 503/);
});

test('webui model cache invalidation clears in-memory and persisted errors', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-model-cache-invalidate-'));
  const state = {
    webUiModelsCache: {
      updatedAt: Date.now(),
      byProvider: { claude: ['opus[1m]'] },
      byAccount: { [GEMINI_ACCOUNT_REF]: ['opus[1m]'] },
      errorsByAccount: { [GEMINI_ACCOUNT_REF]: 'Unexpected token <' },
      labels: {},
      signature: 'stale',
      source: 'local',
      sourceCount: 1,
      scannedAccounts: 1,
      firstError: 'Unexpected token <'
    }
  };

  try {
    invalidateWebUiModelsCache(state, { fs, aiHomeDir });
    assert.equal(state.webUiModelsCache.firstError, '');
    assert.deepEqual(state.webUiModelsCache.byProvider, {});

    const reloaded = await getWebUiModelsCache({ accounts: {}, modelRegistry: { providers: {} } }, { provider: 'auto' }, {
      fs,
      aiHomeDir,
      fetchModelsForAccount: async () => {
        throw new Error('should read empty persisted cache');
      }
    });

    assert.equal(reloaded.cached, true);
    assert.equal(reloaded.firstError, '');
    assert.deepEqual(reloaded.models, {});
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('webui model cache account invalidation preserves other persisted account probes', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-webui-model-cache-account-invalidate-'));
  const createState = () => ({
    accounts: {
      agy: [{
        id: 'a1',
        accountRef: AGY_ACCOUNT_REF,
        provider: 'agy',
        accessToken: 'token-a'
      }],
      gemini: [{
        id: 'g1',
        accountRef: GEMINI_ACCOUNT_REF,
        provider: 'gemini',
        accessToken: 'token-g'
      }]
    },
    modelRegistry: { providers: { agy: new Set(), gemini: new Set() } }
  });

  try {
    const first = await getWebUiModelsCache(createState(), { provider: 'auto' }, {
      forceRefresh: true,
      accountLimit: 0,
      fs,
      aiHomeDir,
      fetchModelsForAccount: async (_options, account) => (
        account.provider === 'agy' ? ['claude-sonnet-4-6'] : ['gemini-2.5-pro']
      )
    });

    assert.deepEqual(first.byAccount[AGY_ACCOUNT_REF], ['claude-sonnet-4-6']);
    assert.deepEqual(first.byAccount[GEMINI_ACCOUNT_REF], ['gemini-2.5-pro']);

    invalidateWebUiModelsCacheAccountRefs(createState(), { fs, aiHomeDir }, [AGY_ACCOUNT_REF]);

    const cached = await getWebUiModelsCache(createState(), { provider: 'auto' }, {
      fs,
      aiHomeDir,
      fetchModelsForAccount: async () => {
        throw new Error('should read persisted cache without probing');
      }
    });

    assert.equal(cached.cached, true);
    assert.equal(Object.prototype.hasOwnProperty.call(cached.byAccount, AGY_ACCOUNT_REF), false);
    assert.deepEqual(cached.byAccount[GEMINI_ACCOUNT_REF], ['gemini-2.5-pro']);
  } finally {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
});

test('webui model cache refreshes codex oauth account cache through native catalog', async () => {
  const account = {
    id: 'c3',
    accountRef: CODEX_ACCOUNT_REF,
    provider: 'codex',
    accessToken: 'oauth-token',
    authType: 'oauth',
    uniqueKey: 'oauth:codex:user@example.com'
  };
  const state = {
    accounts: { codex: [account] },
    modelRegistry: { providers: { codex: new Set() } },
    webUiModelsCache: {
      updatedAt: Date.now(),
      byProvider: { codex: ['gpt-global-cache'] },
      byAccount: {
        [CODEX_ACCOUNT_REF]: ['claude-stale-cache']
      },
      errorsByAccount: {},
      labels: {},
      signature: '',
      source: 'remote',
      sourceCount: 1,
      scannedAccounts: 1,
      firstError: ''
    }
  };

  const result = await getWebUiModelsCache(state, { provider: 'auto' }, {
    forceRefresh: true,
    accountScope: { accountRef: CODEX_ACCOUNT_REF },
    accountLimit: 8,
    fetchModelsForAccount: async () => {
      return ['gpt-5.6-codex'];
    }
  });

  assert.equal(result.cached, false);
  assert.equal(result.scannedAccounts, 1);
  assert.deepEqual(result.byAccount[CODEX_ACCOUNT_REF], ['gpt-5.6-codex']);
  assert.deepEqual(result.errorsByAccount, {});
});

test('webui model cache keeps codex oauth models when native catalog returns empty', async () => {
  const account = {
    id: 'c3',
    accountRef: CODEX_ACCOUNT_REF,
    provider: 'codex',
    accessToken: 'oauth-token',
    authType: 'oauth',
    uniqueKey: 'oauth:codex:user@example.com'
  };
  const state = {
    accounts: { codex: [account] },
    modelRegistry: { providers: { codex: new Set() } },
    webUiModelsCache: {
      updatedAt: Date.now(),
      byProvider: { codex: ['gpt-5.4', 'gpt-5.5'] },
      byAccount: {
        [CODEX_ACCOUNT_REF]: ['gpt-5.4', 'gpt-5.5']
      },
      errorsByAccount: {},
      labels: {},
      signature: '',
      source: 'remote',
      sourceCount: 1,
      scannedAccounts: 1,
      firstError: ''
    }
  };

  const result = await getWebUiModelsCache(state, { provider: 'auto' }, {
    forceRefresh: true,
    accountScope: { accountRef: CODEX_ACCOUNT_REF },
    accountLimit: 8,
    fetchModelsForAccount: async () => []
  });

  assert.equal(result.cached, false);
  assert.equal(result.source, 'error');
  assert.equal(result.firstError, 'empty_codex_models_catalog');
  assert.deepEqual(result.byAccount[CODEX_ACCOUNT_REF], ['gpt-5.4', 'gpt-5.5']);
  assert.equal(result.errorsByAccount[CODEX_ACCOUNT_REF], 'empty_codex_models_catalog');
});

test('webui scoped model cache keeps account metadata after another scoped refresh', async () => {
  const opencodeAccount = {
    id: 'o1',
    accountRef: OPENCODE_ACCOUNT_REF,
    provider: 'opencode',
    accessToken: 'token',
    uniqueKey: 'oauth:opencode:user@example.com'
  };
  const codexAccount = {
    id: 'c3',
    accountRef: CODEX_ACCOUNT_REF,
    provider: 'codex',
    accessToken: 'oauth-token',
    authType: 'oauth',
    uniqueKey: 'oauth:codex:user@example.com'
  };
  const state = {
    accounts: {
      opencode: [opencodeAccount],
      codex: [codexAccount]
    },
    modelRegistry: { providers: { opencode: new Set(), codex: new Set() } }
  };

  const first = await getWebUiModelsCache(state, { provider: 'auto' }, {
    forceRefresh: true,
    accountScope: { accountRef: OPENCODE_ACCOUNT_REF },
    accountLimit: 8,
    fetchModelsForAccount: async () => ['openai/gpt-5.1-codex']
  });

  assert.equal(first.source, 'remote');
  assert.equal(first.scannedAccounts, 1);
  assert.deepEqual(first.byAccount[OPENCODE_ACCOUNT_REF], ['openai/gpt-5.1-codex']);

  const second = await getWebUiModelsCache(state, { provider: 'auto' }, {
    forceRefresh: true,
    accountScope: { accountRef: CODEX_ACCOUNT_REF },
    accountLimit: 8,
    fetchModelsForAccount: async () => {
      return ['gpt-5.6-codex'];
    }
  });

  assert.equal(second.source, 'remote');
  assert.equal(second.scannedAccounts, 1);
  assert.deepEqual(second.byAccount[CODEX_ACCOUNT_REF], ['gpt-5.6-codex']);

  const cached = await getWebUiModelsCache(state, { provider: 'auto' }, {
    accountScope: { accountRef: OPENCODE_ACCOUNT_REF },
    accountLimit: 8,
    fetchModelsForAccount: async () => {
      throw new Error('should read scoped cache');
    }
  });

  assert.equal(cached.cached, true);
  assert.equal(cached.source, 'remote');
  assert.equal(cached.sourceCount, 1);
  assert.equal(cached.scannedAccounts, 1);
  assert.deepEqual(cached.byAccount[OPENCODE_ACCOUNT_REF], ['openai/gpt-5.1-codex']);
});
