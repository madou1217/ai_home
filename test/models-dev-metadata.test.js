const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildModelMetadataMap,
  inferModelsDevProviderIds,
  parseTomlDocument
} = require('../lib/server/models-dev-metadata');

function writeFixture(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('models.dev metadata inherits base model and provider cost overrides', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-models-dev-'));
  try {
    writeFixture(root, 'models/openai/gpt-5.toml', `
name = "GPT-5"
family = "gpt"
release_date = "2025-08-07"
last_updated = "2025-08-07"
knowledge = "2024-09-30"
attachment = true
reasoning = true
temperature = false
tool_call = true
structured_output = true
open_weights = false

[limit]
context = 400_000
input = 272_000
output = 128_000

[modalities]
input = ["text", "image"]
output = ["text"]
`);
    writeFixture(root, 'providers/openai/models/gpt-5.toml', `
base_model = "openai/gpt-5"
reasoning_options = [{ type = "effort", values = ["minimal", "low", "medium", "high"] }]

[cost]
input = 1.25
output = 10
cache_read = 0.125
`);

    const metadata = buildModelMetadataMap([{ id: 'gpt-5', provider: 'codex' }], {
      fs,
      modelsDevDir: root
    });

    assert.equal(metadata['gpt-5'].name, 'GPT-5');
    assert.equal(metadata['gpt-5'].providerId, 'openai');
    assert.equal(metadata['gpt-5'].baseModel, 'openai/gpt-5');
    assert.equal(metadata['gpt-5'].family, 'gpt');
    assert.equal(metadata['gpt-5'].capabilities.temperature, false);
    assert.equal(metadata['gpt-5'].capabilities.reasoningOptions[0].type, 'effort');
    assert.deepEqual(metadata['gpt-5'].capabilities.reasoningOptions[0].values, ['minimal', 'low', 'medium', 'high']);
    assert.equal(metadata['gpt-5'].limits.context, 400000);
    assert.equal(metadata['gpt-5'].limits.output, 128000);
    assert.equal(metadata['gpt-5'].cost.input, 1.25);
    assert.equal(metadata['gpt-5'].cost.cacheRead, 0.125);
    assert.equal(metadata['gpt-5'].source.path, 'providers/openai/models/gpt-5.toml');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('models.dev metadata maps OpenCode Go public prefix to provider model file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-models-dev-opencode-'));
  try {
    writeFixture(root, 'providers/opencode-go/models/glm-5.2.toml', `
name = "GLM-5.2"
family = "glm"
tool_call = true
temperature = true

[limit]
context = 1_000_000
output = 131_072

[cost]
input = 1.4
output = 4.4
`);

    const metadata = buildModelMetadataMap([{ id: 'opencode-go/glm-5.2', provider: 'opencode' }], {
      fs,
      modelsDevDir: root
    });

    assert.equal(metadata['opencode-go/glm-5.2'].providerId, 'opencode-go');
    assert.equal(metadata['opencode-go/glm-5.2'].name, 'GLM-5.2');
    assert.equal(metadata['opencode-go/glm-5.2'].limits.context, 1000000);
    assert.equal(metadata['opencode-go/glm-5.2'].cost.output, 4.4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('models.dev metadata returns an empty map when the submodule is missing', () => {
  const missingRoot = path.join(os.tmpdir(), `aih-missing-models-dev-${Date.now()}`);
  const metadata = buildModelMetadataMap([{ id: 'gpt-5', provider: 'codex' }], {
    fs,
    modelsDevDir: missingRoot
  });
  assert.deepEqual(metadata, {});
});

test('models.dev metadata parses the TOML subset used by model fixtures', () => {
  const parsed = parseTomlDocument(`
name = "Example"
attachment = true
reasoning_options = [{ type = "effort", values = ["low", "high"] }]

[limit]
context = 200_000

[[cost.tiers]]
tier = { size = 256_000 }
input = 1.2
output = 4.8

[[benchmarks]]
name = "Should Not Override Root Name"
`);
  assert.equal(parsed.name, 'Example');
  assert.equal(parsed.attachment, true);
  assert.equal(parsed.limit.context, 200000);
  assert.equal(parsed.cost.tiers[0].tier.size, 256000);
  assert.equal(parsed.cost.tiers[0].input, 1.2);
  assert.deepEqual(parsed.reasoning_options, [{ type: 'effort', values: ['low', 'high'] }]);
});

test('models.dev provider inference keeps AIH provider separate from catalog provider', () => {
  assert.deepEqual(inferModelsDevProviderIds('codex', 'gpt-5'), ['openai', 'github-copilot']);
  assert.deepEqual(inferModelsDevProviderIds('claude', 'claude-sonnet-4-5'), ['anthropic']);
  assert.deepEqual(inferModelsDevProviderIds('opencode', 'opencode-go/glm-5.2'), ['opencode-go', 'opencode']);
});
