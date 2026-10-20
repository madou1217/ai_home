'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  attachModelMetadata,
  buildModelMetadataMap,
  inferModelsDevProviderIds,
  readPricingSourceStatus
} = require('../lib/server/models-dev-metadata');

function writeCatalogFixture(catalog) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-models-dev-catalog-'));
  const filePath = path.join(root, 'catalog.json');
  fs.writeFileSync(filePath, JSON.stringify(catalog));
  return { filePath, root };
}

test('models.dev metadata reads resolved provider records from the fixed API catalog', () => {
  const canonical = {
    id: 'openai/gpt-5',
    name: 'GPT-5',
    family: 'gpt',
    release_date: '2025-08-07',
    last_updated: '2025-08-07',
    knowledge: '2024-09-30',
    attachment: true,
    reasoning: true,
    temperature: false,
    tool_call: true,
    structured_output: true,
    open_weights: false,
    limit: { context: 400000, input: 272000, output: 128000 },
    modalities: { input: ['text', 'image'], output: ['text'] }
  };
  const fixture = writeCatalogFixture({
    models: { 'openai/gpt-5': canonical },
    providers: {
      openai: {
        id: 'openai',
        models: {
          'gpt-5': {
            ...canonical,
            id: 'gpt-5',
            reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }],
            cost: { input: 1.25, output: 10, cache_read: 0.125 }
          }
        }
      }
    }
  });

  try {
    const metadata = buildModelMetadataMap([{ id: 'gpt-5', provider: 'codex' }], {
      fs,
      modelsDevCatalogPath: fixture.filePath
    });

    assert.equal(metadata['gpt-5'].name, 'GPT-5');
    assert.equal(metadata['gpt-5'].providerId, 'openai');
    assert.equal(metadata['gpt-5'].baseModel, 'openai/gpt-5');
    assert.equal(metadata['gpt-5'].family, 'gpt');
    assert.equal(metadata['gpt-5'].capabilities.temperature, false);
    assert.equal(metadata['gpt-5'].capabilities.reasoningOptions[0].type, 'effort');
    assert.deepEqual(
      metadata['gpt-5'].capabilities.reasoningOptions[0].values,
      ['minimal', 'low', 'medium', 'high']
    );
    assert.equal(metadata['gpt-5'].limits.context, 400000);
    assert.equal(metadata['gpt-5'].limits.output, 128000);
    assert.equal(metadata['gpt-5'].cost.input, 1.25);
    assert.equal(metadata['gpt-5'].cost.cacheRead, 0.125);
    assert.equal(metadata['gpt-5'].source.url, 'https://models.dev/catalog.json');
    assert.equal(metadata['gpt-5'].source.path, 'providers/openai/models/gpt-5');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('models.dev metadata maps OpenCode Go public prefix to provider catalog entry', () => {
  const fixture = writeCatalogFixture({
    models: {
      'zhipuai/glm-5.2': {
        id: 'zhipuai/glm-5.2',
        name: 'GLM-5.2',
        modalities: { input: ['text'], output: ['text'] }
      }
    },
    providers: {
      'opencode-go': {
        id: 'opencode-go',
        models: {
          'glm-5.2': {
            id: 'glm-5.2',
            name: 'GLM-5.2',
            family: 'glm',
            tool_call: true,
            temperature: true,
            limit: { context: 1000000, output: 131072 },
            modalities: { input: ['text'], output: ['text'] },
            cost: { input: 1.4, output: 4.4 }
          }
        }
      }
    }
  });

  try {
    const metadata = buildModelMetadataMap(
      [{ id: 'opencode-go/glm-5.2', provider: 'opencode' }],
      { fs, modelsDevCatalogPath: fixture.filePath }
    );

    assert.equal(metadata['opencode-go/glm-5.2'].providerId, 'opencode-go');
    assert.equal(metadata['opencode-go/glm-5.2'].name, 'GLM-5.2');
    assert.equal(metadata['opencode-go/glm-5.2'].limits.context, 1000000);
    assert.equal(metadata['opencode-go/glm-5.2'].cost.output, 4.4);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('models.dev metadata returns an empty map when the fixed catalog is missing', () => {
  const missingPath = path.join(os.tmpdir(), `aih-missing-models-dev-${Date.now()}.json`);
  const metadata = buildModelMetadataMap([{ id: 'gpt-5', provider: 'codex' }], {
    fs,
    modelsDevCatalogPath: missingPath
  });
  assert.deepEqual(metadata, {});
});

test('models.dev metadata rejects legacy wrapped snapshot documents', () => {
  const fixture = writeCatalogFixture({
    schemaVersion: 1,
    source: {
      url: 'https://models.dev/catalog.json',
      sha256: '0'.repeat(64)
    },
    catalog: {
      models: {
        'openai/gpt-5': {
          id: 'openai/gpt-5',
          modalities: { input: ['text'], output: ['text'] }
        }
      },
      providers: { openai: { id: 'openai', models: {} } }
    }
  });

  try {
    const metadata = buildModelMetadataMap([{ id: 'gpt-5', provider: 'codex' }], {
      fs,
      modelsDevCatalogPath: fixture.filePath
    });
    assert.deepEqual(metadata, {});
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('models.dev provider inference keeps AIH provider separate from catalog provider', () => {
  assert.deepEqual(inferModelsDevProviderIds('codex', 'gpt-5'), ['openai', 'github-copilot']);
  assert.deepEqual(inferModelsDevProviderIds('claude', 'claude-sonnet-4-5'), ['anthropic']);
  assert.deepEqual(inferModelsDevProviderIds('opencode', 'opencode-go/glm-5.2'), ['opencode-go', 'opencode']);
});

test('models.dev provider inference maps Cline Pass and CodeBuddy family bare model names', () => {
  assert.deepEqual(inferModelsDevProviderIds('cline', 'cline-pass/deepseek-v4-pro'), ['cline-pass']);
  assert.deepEqual(inferModelsDevProviderIds('cline', 'cline-pass/glm-5.3-flash'), ['cline-pass']);
  assert.deepEqual(inferModelsDevProviderIds('codebuddy', 'deepseek-v4.1-flash'), ['opencode-go']);
  assert.deepEqual(inferModelsDevProviderIds('workbuddycn', 'deepseek-v4.1-flash'), ['opencode-go']);
  assert.deepEqual(inferModelsDevProviderIds('workbuddy', 'hy4-preview'), ['tencent-token-plan']);
  assert.deepEqual(inferModelsDevProviderIds('codebuddy', 'default-model'), []);
  assert.deepEqual(inferModelsDevProviderIds('codebuddy', 'auto'), []);
});

test('models.dev provider inference maps zcode to current Z.AI coding plan catalogs', () => {
  const expected = ['zai-coding-plan', 'zhipuai-coding-plan', 'zai', 'zhipuai'];
  assert.deepEqual(inferModelsDevProviderIds('zcode', 'glm-5.3'), expected);
  assert.deepEqual(inferModelsDevProviderIds('', 'glm-5-turbo'), expected);
});

test('bundled models.dev catalog resolves zcode through a coding plan provider', () => {
  const metadata = buildModelMetadataMap([{ id: 'glm-5.3', provider: 'zcode' }]);

  assert.equal(metadata['glm-5.3'].providerId, 'zai-coding-plan');
  assert.equal(metadata['glm-5.3'].baseModel, 'zhipuai/glm-5.3');
  assert.equal(metadata['glm-5.3'].limits.context, 1000000);
});

test('models.dev provider inference maps kimi to coding and moonshotai catalogs', () => {
  assert.deepEqual(inferModelsDevProviderIds('kimi', 'kimi-k3'), ['kimi-code-plan-global', 'kimi-code-plan-cn', 'moonshotai-cn', 'moonshotai', 'kimi-for-coding']);
  assert.deepEqual(inferModelsDevProviderIds('kimi', 'k3'), ['kimi-code-plan-global', 'kimi-code-plan-cn', 'moonshotai-cn', 'moonshotai', 'kimi-for-coding']);
  assert.deepEqual(inferModelsDevProviderIds('', 'kimi-for-coding-highspeed'), ['kimi-code-plan-global', 'kimi-code-plan-cn', 'kimi-for-coding']);
  assert.deepEqual(inferModelsDevProviderIds('', 'k3-256k'), ['kimi-code-plan-global', 'kimi-code-plan-cn', 'kimi-for-coding']);
  assert.deepEqual(inferModelsDevProviderIds('', 'gpt-5'), []);
});

test('models.dev metadata resolves capability-suffix variants to their base model', () => {
  const fixture = writeCatalogFixture({
    models: {
      'anthropic/claude-opus-4-6': {
        id: 'anthropic/claude-opus-4-6',
        name: 'Claude Opus 4.6',
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
      },
      'moonshotai/kimi-k2-thinking': {
        id: 'moonshotai/kimi-k2-thinking',
        name: 'Kimi K2 Thinking',
        modalities: { input: ['text'], output: ['text'] }
      },
      'moonshotai/kimi-k2': {
        id: 'moonshotai/kimi-k2',
        name: 'Kimi K2',
        modalities: { input: ['text', 'image'], output: ['text'] }
      }
    },
    providers: {
      anthropic: { id: 'anthropic', models: {} }
    }
  });

  try {
    const metadata = buildModelMetadataMap([
      { id: 'claude-opus-4-6-thinking', provider: 'agy' },
      { id: 'kimi-k2-thinking', provider: 'kimi' }
    ], { fs, modelsDevCatalogPath: fixture.filePath });

    // 后缀变体裁到基座模型并继承其模态（图片附件/视频帧因此可用）
    assert.equal(metadata['claude-opus-4-6-thinking'].baseModel, 'anthropic/claude-opus-4-6');
    assert.deepEqual(metadata['claude-opus-4-6-thinking'].modalities.input, ['text', 'image', 'pdf']);
    // 目录里真实存在的 -thinking 本体必须优先于裁后缀结果
    assert.equal(metadata['kimi-k2-thinking'].baseModel, 'moonshotai/kimi-k2-thinking');
    assert.deepEqual(metadata['kimi-k2-thinking'].modalities.input, ['text']);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('models.dev metadata inherits base-provider pricing for alias variants', () => {
  const fixture = writeCatalogFixture({
    models: {
      'anthropic/claude-opus-4-6': {
        id: 'anthropic/claude-opus-4-6',
        modalities: { input: ['text'], output: ['text'] }
      },
      'anthropic/claude-sonnet-4-5': {
        id: 'anthropic/claude-sonnet-4-5',
        modalities: { input: ['text'], output: ['text'] }
      },
      'deepseek/deepseek-v4-pro': {
        id: 'deepseek/deepseek-v4-pro',
        modalities: { input: ['text'], output: ['text'] }
      },
      'alibaba/qwen3.8-flash': {
        id: 'alibaba/qwen3.8-flash',
        modalities: { input: ['text'], output: ['text'] }
      }
    },
    providers: {
      anthropic: {
        id: 'anthropic',
        models: {
          'claude-opus-4-6': {
            id: 'claude-opus-4-6',
            cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 }
          },
          'claude-sonnet-4-5': {
            id: 'claude-sonnet-4-5',
            cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }
          }
        }
      },
      deepseek: {
        id: 'deepseek',
        models: {
          'deepseek-v4-pro': {
            id: 'deepseek-v4-pro',
            cost: { input: 0.66, output: 1.98, cache_read: 0.022 }
          }
        }
      },
      alibaba: {
        id: 'alibaba',
        models: {
          'qwen3.8-flash': {
            id: 'qwen3.8-flash',
            cost: { input: 0.15, output: 0.47, cache_read: 0.016 }
          }
        }
      }
    }
  });

  try {
    const metadata = buildModelMetadataMap([
      { id: 'claude-opus-4-6-thinking', provider: 'claude' },
      { id: 'claude-sonnet-4.5', provider: 'kiro' },
      { id: 'deepseek-v4-pro', provider: 'codex' },
      { id: 'Qwen3.8-Flash', provider: 'qoder' }
    ], { fs, modelsDevCatalogPath: fixture.filePath });

    assert.equal(metadata['claude-opus-4-6-thinking'].baseModel, 'anthropic/claude-opus-4-6');
    assert.equal(metadata['claude-opus-4-6-thinking'].cost.input, 5);
    assert.equal(metadata['claude-sonnet-4.5'].baseModel, 'anthropic/claude-sonnet-4-5');
    assert.equal(metadata['claude-sonnet-4.5'].cost.cacheWrite, 3.75);
    assert.equal(metadata['deepseek-v4-pro'].cost.input, 0.66);
    assert.equal(metadata['Qwen3.8-Flash'].cost.cacheRead, 0.016);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('models.dev provider inference maps Grok to xAI catalog entries', () => {
  assert.deepEqual(
    inferModelsDevProviderIds('grok', 'grok-4.7'),
    ['xai', 'github-copilot']
  );
});


test('models.dev metadata carries pricing provenance and explicit unknown status', () => {
  const catalog = {
    generatedAt: '2026-09-01T00:00:00.000Z',
    models: {
      'openai/gpt-priced': { id: 'openai/gpt-priced' }
    },
    providers: {
      openai: {
        id: 'openai',
        models: {
          'gpt-priced': { id: 'gpt-priced', cost: { input: 1.25, output: 10 } },
          'gpt-free': { id: 'gpt-free', cost: { input: 0, output: 0 } }
        }
      }
    }
  };
  const options = {
    modelsDevCatalog: catalog,
    now: Date.parse('2026-10-20T00:00:00.000Z')
  };

  const priced = buildModelMetadataMap([{ id: 'gpt-priced', provider: 'codex' }], options)['gpt-priced'];
  assert.equal(priced.cost.input, 1.25);
  assert.equal(priced.pricing.status, 'priced');
  assert.equal(priced.pricing.source.id, 'models.dev');
  assert.equal(priced.pricing.source.authority, 40);
  assert.equal(priced.pricing.fetchedAt, undefined);
  assert.equal(priced.pricing.source.fetchedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(priced.pricing.stale, true);
  assert.equal(priced.pricingSource, 'models.dev');
  assert.equal(priced.pricingAuthority, 40);
  assert.equal(priced.pricingStale, true);

  const free = buildModelMetadataMap([{ id: 'gpt-free', provider: 'codex' }], options)['gpt-free'];
  assert.equal(free.pricing.status, 'free');

  const unknown = attachModelMetadata([{ id: 'not-in-catalog', provider: 'codex' }], options)[0].metadata;
  assert.equal(unknown.pricing.status, 'unknown');
  assert.equal(unknown.pricingSource, 'models.dev');
  assert.equal(unknown.cost, undefined);
});

test('pricing source status marks snapshots older than 14 days as stale', () => {
  const lines = readPricingSourceStatus({
    modelsDevCatalog: {
      generatedAt: '2026-09-01T00:00:00.000Z',
      models: { 'openai/gpt': { id: 'openai/gpt' } },
      providers: { openai: { models: { gpt: { id: 'gpt', cost: { input: 1 } } } } }
    },
    now: Date.parse('2026-10-20T00:00:00.000Z')
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /pricing: models\.dev/);
  assert.match(lines[0], /stale=true/);
});
