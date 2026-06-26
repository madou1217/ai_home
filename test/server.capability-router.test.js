const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGatewayProvider } = require('../lib/server/capability-router');

const CODEX_REF_1 = 'acct_0123456789abcdefabcd';
const CODEX_REF_2 = 'acct_abcdefabcdefabcdefab';
const GEMINI_REF_1 = 'acct_11111111111111111111';
const CLAUDE_REF_1 = 'acct_22222222222222222222';
const AGY_REF_1 = 'acct_33333333333333333333';

test('capability router routes aliased claude requests to codex account pool', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [
          { id: 'c1', accountRef: CODEX_REF_1, provider: 'codex', accessToken: 'codex-token-1' },
          { id: 'c2', accountRef: CODEX_REF_2, provider: 'codex', accessToken: 'codex-token-2' }
        ],
        gemini: [],
        claude: []
      }
    },
    requestJson: { model: 'gpt-5.5' },
    headers: {},
    clientProtocol: 'anthropic_messages'
  });

  assert.equal(result.provider, 'codex');
  assert.equal(result.source, 'model_family');
});

test('capability router rejects unavailable model-family provider instead of borrowing a wrong family', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [{
          id: 'c1',
          accountRef: CODEX_REF_1,
          provider: 'codex',
          accessToken: 'codex-token',
          availableModels: ['gpt-5.5'],
          cooldownUntil: Date.now() + 60_000
        }],
        gemini: [{ id: 'g1', accountRef: GEMINI_REF_1, provider: 'gemini', accessToken: 'gemini-token', availableModels: ['gemini-3.1-pro-preview'] }],
        claude: []
      }
    },
    requestJson: { model: 'gpt-5.5' },
    headers: {},
    clientProtocol: 'anthropic_messages'
  });

  assert.equal(result.provider, '');
  assert.equal(result.error, 'no_account_supports_model');
  assert.equal(result.familyProvider, 'codex');
  assert.equal(result.availability.providers.codex.accounts, 1);
  assert.equal(result.availability.providers.codex.available, 0);
  assert.equal(result.availability.providers.gemini.available, 1);
});

test('capability router uses model availability before model-family fallback', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [{ id: 'c1', accountRef: CODEX_REF_1, provider: 'codex', accessToken: 'codex-token' }],
        gemini: [],
        claude: [{ id: 'q1', accountRef: CLAUDE_REF_1, provider: 'claude', accessToken: 'claude-token', availableModels: ['qwen3.6-plus'] }]
      },
      webUiModelsCache: {
        byProvider: {
          codex: ['gpt-5.5'],
          claude: ['qwen3.6-plus']
        }
      }
    },
    requestJson: { model: 'qwen3.6-plus' },
    headers: {},
    clientProtocol: 'openai_responses'
  });

  assert.equal(result.provider, 'claude');
  assert.equal(result.source, 'model_capability');
});

test('capability router rejects known model when all account model entries are disabled', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [
          { id: '1', accountRef: CODEX_REF_1, provider: 'codex', accessToken: 'codex-token-1' },
          { id: '2', accountRef: CODEX_REF_2, provider: 'codex', accessToken: 'codex-token-2' }
        ],
        gemini: [],
        claude: [],
        agy: []
      },
      webUiModelsCache: {
        byProvider: {
          codex: ['a', 'c']
        },
        byAccount: {
          [CODEX_REF_1]: ['a', 'c'],
          [CODEX_REF_2]: ['c']
        }
      },
      modelCatalogSettings: {
        version: 2,
        accountModels: [
          { id: 'c', provider: 'codex', accountRef: CODEX_REF_1, enabled: false },
          { id: 'c', provider: 'codex', accountRef: CODEX_REF_2, enabled: false }
        ]
      }
    },
    requestJson: { model: 'c' },
    headers: {},
    clientProtocol: 'openai_responses'
  });

  assert.equal(result.provider, '');
  assert.equal(result.error, 'no_account_supports_model');
  assert.equal(result.familyProvider, 'codex');
});


test('capability router routes alias target through provider that supports the requested alias model', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [{ id: 'c1', accountRef: CODEX_REF_1, provider: 'codex', accessToken: 'codex-token' }],
        gemini: [],
        claude: [],
        agy: [{ id: 'a1', accountRef: AGY_REF_1, provider: 'agy', accessToken: 'agy-token', availableModels: ['claude-sonnet-4-6'] }]
      },
      webUiModelsCache: {
        byProvider: {
          agy: ['claude-sonnet-4-6']
        }
      }
    },
    requestJson: { model: 'claude-opus-4-6-thinking' },
    headers: {},
    clientProtocol: 'anthropic_messages',
    preferModelRouting: true,
    aliasResolution: {
      aliasMatched: true,
      requestedModel: 'claude-sonnet-4-6',
      effectiveModel: 'claude-opus-4-6-thinking'
    }
  });

  assert.equal(result.provider, 'agy');
  assert.equal(result.source, 'alias_requested_model_capability');
});

test('capability router does not choose protocol provider when model is missing', () => {
  const input = {
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [{ id: 'c1', accountRef: CODEX_REF_1, provider: 'codex', accessToken: 'codex-token', availableModels: ['gpt-5.5'] }],
        gemini: [],
        claude: [{ id: 'cl1', accountRef: CLAUDE_REF_1, provider: 'claude', accessToken: 'claude-token', availableModels: ['claude-sonnet-4-5'] }],
        agy: []
      }
    },
    requestJson: { messages: [{ role: 'user', content: 'ping' }] },
    headers: {},
    clientProtocol: 'anthropic_messages'
  };

  const result = resolveGatewayProvider(input);

  assert.equal(result.provider, '');
  assert.equal(result.error, 'missing_model');
  assert.equal(result.detail, 'request model is required for provider routing');

  const explicitHeaderResult = resolveGatewayProvider({
    ...input,
    headers: { 'x-provider': 'claude' }
  });
  assert.equal(explicitHeaderResult.provider, '');
  assert.equal(explicitHeaderResult.error, 'missing_model');
});

test('capability router routes Anthropic alias targets through AGY protocol capability when model list omits Claude IDs', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [{ id: 'c1', accountRef: CODEX_REF_1, provider: 'codex', accessToken: 'codex-token' }],
        gemini: [],
        claude: [],
        agy: [{ id: 'a1', accountRef: AGY_REF_1, provider: 'agy', accessToken: 'agy-token', availableModels: ['gemini-3.1-pro-preview'] }]
      }
    },
    requestJson: { model: 'claude-opus-4-6-thinking' },
    headers: {},
    clientProtocol: 'anthropic_messages',
    preferModelRouting: true,
    aliasResolution: {
      aliasMatched: true,
      requestedModel: 'claude-sonnet-4-6',
      effectiveModel: 'claude-opus-4-6-thinking'
    }
  });

  assert.equal(result.provider, 'agy');
  assert.equal(result.source, 'provider_protocol_route');
});

test('capability router keeps AGY protocol route for dotted Anthropic alias targets', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [{ id: 'c1', accountRef: CODEX_REF_1, provider: 'codex', accessToken: 'codex-token' }],
        gemini: [],
        claude: [],
        agy: [{ id: 'a1', accountRef: AGY_REF_1, provider: 'agy', accessToken: 'agy-token', availableModels: ['gemini-3.1-pro-preview'] }]
      }
    },
    requestJson: { model: 'claude-opus-4.6-thinking' },
    headers: {},
    clientProtocol: 'anthropic_messages',
    preferModelRouting: true,
    aliasResolution: {
      aliasMatched: true,
      requestedModel: 'claude-sonnet-4-6',
      effectiveModel: 'claude-opus-4.6-thinking'
    }
  });

  assert.equal(result.provider, 'agy');
  assert.equal(result.source, 'provider_protocol_route');
});

test('capability router returns global diagnostics when model family has no accounts', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [{ id: 'c1', accountRef: CODEX_REF_1, provider: 'codex', accessToken: 'codex-token' }],
        gemini: [],
        claude: []
      }
    },
    requestJson: { model: 'claude-opus-4-7' },
    headers: {},
    clientProtocol: 'anthropic_messages'
  });

  assert.equal(result.provider, '');
  assert.equal(result.error, 'no_account_supports_model');
  assert.equal(result.familyProvider, 'claude');
  assert.equal(result.availability.provider, 'global');
  assert.equal(result.availability.providers.codex.accounts, 1);
  assert.equal(result.availability.providers.claude.accounts, 0);
});

test('capability router keeps explicit alias target provider above client headers', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [{ id: 'c1', accountRef: CODEX_REF_1, provider: 'codex', accessToken: 'codex-token' }],
        gemini: [],
        claude: []
      }
    },
    requestJson: { model: 'gpt-5.5' },
    headers: { 'x-provider': 'claude' },
    aliasTargetProvider: 'codex',
    clientProtocol: 'anthropic_messages'
  });

  assert.equal(result.provider, 'codex');
  assert.equal(result.source, 'alias_target_provider');
});
