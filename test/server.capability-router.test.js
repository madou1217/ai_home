const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGatewayProvider } = require('../lib/server/capability-router');

test('capability router routes aliased claude requests to codex account pool', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [
          { id: 'c1', provider: 'codex', accessToken: 'codex-token-1' },
          { id: 'c2', provider: 'codex', accessToken: 'codex-token-2' }
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
          provider: 'codex',
          accessToken: 'codex-token',
          availableModels: ['gpt-5.5'],
          cooldownUntil: Date.now() + 60_000
        }],
        gemini: [{ id: 'g1', provider: 'gemini', accessToken: 'gemini-token', availableModels: ['gemini-3.1-pro-preview'] }],
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
        codex: [{ id: 'c1', provider: 'codex', accessToken: 'codex-token' }],
        gemini: [],
        claude: [{ id: 'q1', provider: 'claude', accessToken: 'claude-token', availableModels: ['qwen3.6-plus'] }]
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

test('capability router returns global diagnostics when model family has no accounts', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [{ id: 'c1', provider: 'codex', accessToken: 'codex-token' }],
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
        codex: [{ id: 'c1', provider: 'codex', accessToken: 'codex-token' }],
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
