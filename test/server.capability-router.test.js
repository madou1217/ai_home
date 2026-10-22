const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveGatewayProvider } = require('../lib/server/capability-router');
const { inferProviderFromScopedModelId } = require('../lib/server/providers');

const CODEX_REF_1 = 'acct_0123456789abcdefabcd';
const CODEX_REF_2 = 'acct_abcdefabcdefabcdefab';
const GEMINI_REF_1 = 'acct_11111111111111111111';
const CLAUDE_REF_1 = 'acct_22222222222222222222';
const AGY_REF_1 = 'acct_33333333333333333333';
const OPENCODE_REF_1 = 'acct_44444444444444444444';
const OPENCODE_REF_2 = 'acct_55555555555555555555';
const CLINE_REF_1 = 'acct_66666666666666666666';
const WORKBUDDY_REF_1 = 'acct_77777777777777777777';

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

test('capability router pins non-aliased gpt-5.5 to codex even when a claude reseller advertises gpt-5.5', () => {
  // 回归:codex 家族模型(gpt-*)的直连请求,不许被"目录里恰好也宣称支持 gpt-5.5"的 claude
  // 中转账号抢路由。严格家族路由必须把它锁死到 codex,即便 claude 侧也有可用账号。
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [{ id: 'c1', accountRef: CODEX_REF_1, provider: 'codex', accessToken: 'codex-token', availableModels: ['gpt-5.5'] }],
        gemini: [],
        claude: [{ id: 'cl1', accountRef: CLAUDE_REF_1, provider: 'claude', accessToken: 'claude-token', availableModels: ['gpt-5.5'] }],
        agy: []
      },
      webUiModelsCache: {
        byProvider: { codex: ['gpt-5.5'], claude: ['gpt-5.5'] }
      }
    },
    requestJson: { model: 'gpt-5.5' },
    headers: {},
    clientProtocol: 'openai_responses'
  });

  assert.equal(result.provider, 'codex');
  assert.equal(result.source, 'model_family');
});

test('capability router reports codex-truthful unavailability for non-aliased gpt-5.5 instead of misblaming an available claude reseller', () => {
  // 回归:codex 冷却时,gpt-5.5 直连请求必须如实报 codex 不可用(familyProvider=codex),
  // 而不是悄悄兜底到"也宣称支持 gpt-5.5"的 claude 账号上、再甩锅 "no available claude account"。
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [{ id: 'c1', accountRef: CODEX_REF_1, provider: 'codex', accessToken: 'codex-token', availableModels: ['gpt-5.5'], cooldownUntil: Date.now() + 60_000 }],
        gemini: [],
        claude: [{ id: 'cl1', accountRef: CLAUDE_REF_1, provider: 'claude', accessToken: 'claude-token', availableModels: ['gpt-5.5'] }],
        agy: []
      },
      webUiModelsCache: {
        byProvider: { codex: ['gpt-5.5'], claude: ['gpt-5.5'] }
      }
    },
    requestJson: { model: 'gpt-5.5' },
    headers: {},
    clientProtocol: 'openai_responses'
  });

  assert.equal(result.provider, '');
  assert.equal(result.error, 'no_account_supports_model');
  assert.equal(result.familyProvider, 'codex');
});

test('capability router leaves explicit alias chains untouched (preferModelRouting bypasses strict family pin)', () => {
  // 显式别名链(preferModelRouting=true)保持原语义:按目录匹配跨 provider,不被严格家族路由拦截。
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [{ id: 'c1', accountRef: CODEX_REF_1, provider: 'codex', accessToken: 'codex-token' }],
        gemini: [],
        claude: [],
        agy: [{ id: 'a1', accountRef: AGY_REF_1, provider: 'agy', accessToken: 'agy-token', availableModels: ['claude-sonnet-4-6'] }]
      },
      webUiModelsCache: { byProvider: { agy: ['claude-sonnet-4-6'] } }
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

test('scoped model namespace inference only claims provider-exclusive namespaces', () => {
  // 只认专属命名空间：认不出就说不知道（''），绝不兜底 codex。
  assert.equal(inferProviderFromScopedModelId('cline-pass/deepseek-v4.1-flash'), 'cline');
  assert.equal(inferProviderFromScopedModelId('CLINE-PASS/GLM-5.3'), 'cline');
  assert.equal(inferProviderFromScopedModelId('opencode/deepseek-v4.1-flash-free'), 'opencode');
  assert.equal(inferProviderFromScopedModelId('opencode-go/kimi-k2.6'), 'opencode');
  assert.equal(inferProviderFromScopedModelId('agy-gemini-3.1-pro'), 'agy');
  assert.equal(inferProviderFromScopedModelId('antigravity-claude-opus-4-6'), 'agy');
  assert.equal(inferProviderFromScopedModelId('kiro/claude-sonnet-4.5'), 'kiro');
  assert.equal(inferProviderFromScopedModelId('kr/claude-sonnet-4.5'), 'kiro');
  // 家族名 / 多 provider 可服务的裸模型名不是专属命名空间。
  [
    'claude-opus-5-5',
    'anthropic/claude-opus-5-5',
    'gpt-5.5',
    'gemini-3.5-flash',
    'glm-5.3',
    'zcode-glm-5.3',
    'kimi-k2.6',
    'moonshot-kimi-k2.6',
    'grok-4.7',
    'deepseek-v4.1-flash',
    'cline-free/glm-5.2',
    'cline/glm-5.3',
    '',
    null,
    undefined
  ].forEach((modelId) => {
    assert.equal(inferProviderFromScopedModelId(modelId), '', String(modelId));
  });
});

test('capability router sends an alias-rewritten cline-pass target to cline instead of a protocol-affinity provider', () => {
  // 实测回归(2026-10-15 15:13 /v1/messages)：别名 claude-* → cline-pass/deepseek-v4.1-flash
  // (target_provider=auto) 在 cline 账号不可调度时被 protocol route 兜底到 opencode
  // (anthropic→openai_chat 桥接、可用账号数最多)，产出误导性
  // "no available opencode account can serve model cline-pass/deepseek-v4.1-flash"。
  // 别名目标自带 provider 专属命名空间时，归属必须是命名空间所属 provider。
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [],
        gemini: [],
        claude: [{ id: 'cl1', accountRef: CLAUDE_REF_1, provider: 'claude', accessToken: 'claude-token' }],
        agy: [],
        opencode: [
          { id: 'o1', accountRef: OPENCODE_REF_1, provider: 'opencode', accessToken: 'oc-token-1' },
          { id: 'o2', accountRef: OPENCODE_REF_2, provider: 'opencode', accessToken: 'oc-token-2' }
        ],
        cline: [{
          id: 'cli1',
          accountRef: CLINE_REF_1,
          provider: 'cline',
          accessToken: 'cline-token',
          availableModels: ['cline-pass/deepseek-v4.1-flash'],
          cooldownUntil: Date.now() + 60 * 1000
        }]
      }
    },
    requestJson: { model: 'cline-pass/deepseek-v4.1-flash' },
    headers: {},
    clientProtocol: 'anthropic_messages',
    preferModelRouting: true,
    aliasResolution: {
      aliasMatched: true,
      requestedModel: 'claude-opus-5-5',
      effectiveModel: 'cline-pass/deepseek-v4.1-flash'
    }
  });

  assert.equal(result.provider, 'cline');
  assert.equal(result.source, 'alias_target_model_scope');
});

test('capability router keeps catalog evidence above the alias namespace fallback', () => {
  // auto 语义不变：目录里有可调度账号认领目标模型时，仍按目录裁决（命名空间只是兜底）。
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [],
        gemini: [],
        claude: [{ id: 'cl1', accountRef: CLAUDE_REF_1, provider: 'claude', accessToken: 'claude-token' }],
        agy: [],
        opencode: [
          { id: 'o1', accountRef: OPENCODE_REF_1, provider: 'opencode', accessToken: 'oc-token-1' },
          { id: 'o2', accountRef: OPENCODE_REF_2, provider: 'opencode', accessToken: 'oc-token-2' }
        ],
        cline: [{
          id: 'cli1',
          accountRef: CLINE_REF_1,
          provider: 'cline',
          accessToken: 'cline-token',
          availableModels: ['cline-pass/deepseek-v4.1-flash']
        }]
      }
    },
    requestJson: { model: 'cline-pass/deepseek-v4.1-flash' },
    headers: {},
    clientProtocol: 'anthropic_messages',
    preferModelRouting: true,
    aliasResolution: {
      aliasMatched: true,
      requestedModel: 'claude-opus-5-5',
      effectiveModel: 'cline-pass/deepseek-v4.1-flash'
    }
  });

  assert.equal(result.provider, 'cline');
  assert.equal(result.source, 'model_capability');
});

test('capability router never borrows a protocol-affinity provider for an alias-rewritten model with no provider namespace', () => {
  // 别名目标没有专属命名空间、且没有任何目录认领它时，唯一诚实的结论是 503；
  // 按客户端协议亲和挑池会把别名目标模型发给不认识它的上游。
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [],
        gemini: [],
        claude: [{ id: 'cl1', accountRef: CLAUDE_REF_1, provider: 'claude', accessToken: 'claude-token' }],
        agy: [],
        opencode: [
          { id: 'o1', accountRef: OPENCODE_REF_1, provider: 'opencode', accessToken: 'oc-token-1' },
          { id: 'o2', accountRef: OPENCODE_REF_2, provider: 'opencode', accessToken: 'oc-token-2' }
        ],
        cline: []
      }
    },
    requestJson: { model: 'deepseek-v4.1-flash' },
    headers: {},
    clientProtocol: 'anthropic_messages',
    preferModelRouting: true,
    aliasResolution: {
      aliasMatched: true,
      requestedModel: 'claude-opus-5-5',
      effectiveModel: 'deepseek-v4.1-flash'
    }
  });

  assert.equal(result.provider, '');
  assert.equal(result.source, 'unavailable');
  assert.equal(result.error, 'no_account_supports_model');
  assert.equal(result.detail, 'no available account in the global pool can serve model deepseek-v4.1-flash');
});

test('capability router keeps model-family protocol routes for alias targets on other client protocols', () => {
  // 协议兜底路由必须自带模型家族证据：openai_chat 客户端 + Claude 风格别名目标时，
  // AGY 的 anthropic 直连路由（modelFamilies: ['anthropic']）仍然可用，
  // 而 opencode 的 go_api 路由（对模型一无所知）不再被选中。
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [],
        gemini: [],
        claude: [],
        agy: [{ id: 'a1', accountRef: AGY_REF_1, provider: 'agy', accessToken: 'agy-token', availableModels: ['gemini-3.1-pro-preview'] }],
        opencode: [
          { id: 'o1', accountRef: OPENCODE_REF_1, provider: 'opencode', accessToken: 'oc-token-1' },
          { id: 'o2', accountRef: OPENCODE_REF_2, provider: 'opencode', accessToken: 'oc-token-2' }
        ]
      }
    },
    requestJson: { model: 'claude-opus-4-6-thinking' },
    headers: {},
    clientProtocol: 'openai_chat',
    preferModelRouting: true,
    aliasResolution: {
      aliasMatched: true,
      requestedModel: 'gpt-5.5',
      effectiveModel: 'claude-opus-4-6-thinking'
    }
  });

  assert.equal(result.provider, 'agy');
  assert.equal(result.source, 'provider_protocol_route');
});

// 回归（2026-10-17/18）：opencode 池一时没有该模型的可用绑定（目录重建窗口、账号短暂不健康）时，
// 不带 x-provider 的 `opencode/glm-5.3-flash-free` 被 claude 直通路由按协议亲和接走，
// 报「no available claude account can serve model opencode/…」。命名空间就是家族证据。
function opencodeNamespaceState({ opencodeModels, opencodeCooling = false }) {
  return {
    accounts: {
      codex: [],
      gemini: [],
      claude: [
        { id: 'cl1', accountRef: CLAUDE_REF_1, provider: 'claude', accessToken: 'claude-token-1' },
        { id: 'cl2', accountRef: AGY_REF_1, provider: 'claude', accessToken: 'claude-token-2' }
      ],
      agy: [],
      opencode: [{
        id: 'o1',
        accountRef: OPENCODE_REF_1,
        provider: 'opencode',
        accessToken: 'oc-token-1',
        availableModels: opencodeModels,
        ...(opencodeCooling ? { cooldownUntil: Date.now() + 60_000 } : {})
      }]
    },
    webUiModelsCache: { byProvider: { opencode: opencodeModels } }
  };
}

test('capability router keeps an opencode/ model in the opencode pool even when its catalog binding is momentarily missing', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: opencodeNamespaceState({ opencodeModels: [] }),
    requestJson: { model: 'opencode/glm-5.3-flash-free' },
    headers: {},
    clientProtocol: 'openai_chat'
  });
  assert.equal(result.provider, 'opencode');
  assert.equal(result.source, 'model_family');
});

test('capability router reports opencode-truthful unavailability instead of handing an opencode/ model to claude', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: opencodeNamespaceState({ opencodeModels: ['opencode/glm-5.3-flash-free'], opencodeCooling: true }),
    requestJson: { model: 'opencode/glm-5.3-flash-free' },
    headers: {},
    clientProtocol: 'openai_chat'
  });
  assert.equal(result.provider, '');
  assert.equal(result.familyProvider, 'opencode');
});

test('capability router keeps protocol-affinity routing for requests that were not rewritten by an alias', () => {
  // 直连请求（没有别名改写）保持既有语义：模型家族与目录都没有结论时按客户端协议亲和兜底。
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        codex: [],
        gemini: [],
        claude: [{ id: 'cl1', accountRef: CLAUDE_REF_1, provider: 'claude', accessToken: 'claude-token' }],
        agy: [],
        opencode: [
          { id: 'o1', accountRef: OPENCODE_REF_1, provider: 'opencode', accessToken: 'oc-token-1' },
          { id: 'o2', accountRef: OPENCODE_REF_2, provider: 'opencode', accessToken: 'oc-token-2' }
        ]
      }
    },
    requestJson: { model: 'mystery-enterprise-model-9' },
    headers: {},
    clientProtocol: 'anthropic_messages'
  });

  assert.equal(result.provider, 'opencode');
  assert.equal(result.source, 'provider_protocol_route');
});

// 2026-10-22 真机：gemini-3.5-flash 被前缀推断成 agy（gemini 家族），但上游已把它下架、
// agy 目录只剩 -low / -lite / -extra-low 变体；agy 池有账号 → 家族短路直接返回 →
// 产出误导性的「no available agy account can serve model gemini-3.5-flash」，
// 而真正持有该裸名的 workbuddy 账号从未被考虑。
// 强证据（账号目录真的探测到该模型）必须优先于弱证据（按名字猜家族）。
test('family inference yields to a provider that actually probed the model', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        // agy 有账号，但目录里只有档位变体，没有裸名。
        agy: [{ id: 'a1', accountRef: AGY_REF_1, provider: 'agy', accessToken: 'agy-token',
          availableModels: ['gemini-3.5-flash-low', 'gemini-3.5-flash-lite'] }],
        // workbuddy 真的探测到了裸名。
        workbuddy: [{ id: 'w1', accountRef: WORKBUDDY_REF_1, provider: 'workbuddy', accessToken: 'wb-token',
          availableModels: ['gemini-3.5-flash'] }]
      },
      webUiModelsCache: {
        byProvider: { agy: ['gemini-3.5-flash-low'], workbuddy: ['gemini-3.5-flash'] }
      }
    },
    requestJson: { model: 'gemini-3.5-flash' },
    headers: {},
    clientProtocol: 'openai_responses'
  });

  assert.equal(result.provider, 'workbuddy');
  assert.equal(result.source, 'model_capability');
});

test('family inference still wins when the family catalog knows the model', () => {
  const result = resolveGatewayProvider({
    options: { provider: 'auto' },
    state: {
      accounts: {
        agy: [{ id: 'a1', accountRef: AGY_REF_1, provider: 'agy', accessToken: 'agy-token',
          availableModels: ['gemini-3.5-flash-low'] }],
        // 中转账号也宣称支持同一个档位变体 —— 不该被它抢走。
        claude: [{ id: 'cl1', accountRef: CLAUDE_REF_1, provider: 'claude', accessToken: 'claude-token',
          availableModels: ['gemini-3.5-flash-low'] }]
      },
      webUiModelsCache: {
        byProvider: { agy: ['gemini-3.5-flash-low'], claude: ['gemini-3.5-flash-low'] }
      }
    },
    requestJson: { model: 'gemini-3.5-flash-low' },
    headers: {},
    clientProtocol: 'openai_responses'
  });

  assert.equal(result.provider, 'agy');
  assert.equal(result.source, 'model_family');
});
