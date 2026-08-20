'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildModelMetadataMap,
  inferModelsDevProviderIds
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

test('models.dev metadata fails closed when a wrapped catalog hash is invalid', () => {
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
  assert.deepEqual(inferModelsDevProviderIds('kimi', 'kimi-k3'), ['kimi-for-coding', 'moonshotai-cn', 'moonshotai']);
  assert.deepEqual(inferModelsDevProviderIds('kimi', 'k3'), ['kimi-for-coding', 'moonshotai-cn', 'moonshotai']);
  assert.deepEqual(inferModelsDevProviderIds('', 'kimi-for-coding-highspeed'), ['kimi-for-coding']);
  assert.deepEqual(inferModelsDevProviderIds('', 'k3-256k'), ['kimi-for-coding']);
  assert.deepEqual(inferModelsDevProviderIds('', 'gpt-5'), []);
});
