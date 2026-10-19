import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyProviderConfigOption,
  buildProviderConfigOutline,
  findProviderConfigSchemaField,
  resolveProviderConfigOutlineEntry
} from './provider-config-outline.ts';

const JSON_CONFIG = `{
  "model": "gpt-5",
  "model_providers": {
    "aih": {
      "name": "AIH",
      "env_key": "OPENAI_API_KEY"
    }
  }
}`;

test('json outline resolves nested keys and container ranges', () => {
  const entries = buildProviderConfigOutline(JSON_CONFIG, 'json');
  const leaf = resolveProviderConfigOutlineEntry(entries, 6);
  assert.equal(leaf?.path, 'model_providers.aih.env_key');
  const container = resolveProviderConfigOutlineEntry(entries, 4);
  assert.equal(container?.path, 'model_providers.aih');
  const rootKey = resolveProviderConfigOutlineEntry(entries, 2);
  assert.equal(rootKey?.path, 'model');
});

test('jsonc outline ignores comments and trailing commas', () => {
  const content = `{
  // user comment
  "theme": "system",
  "model": "anthropic/claude", // inline
}`;
  const entries = buildProviderConfigOutline(content, 'jsonc');
  assert.deepEqual(entries.map((entry) => entry.path), ['theme', 'model']);
  assert.equal(resolveProviderConfigOutlineEntry(entries, 4)?.path, 'model');
});

test('toml outline tracks sections and dotted keys', () => {
  const content = `model = "gpt-5"

[mcp_servers.demo]
command = "node"
args = ["--x"]

[profiles."fast mode"]
model = "gpt-5-mini"`;
  const entries = buildProviderConfigOutline(content, 'toml');
  assert.equal(resolveProviderConfigOutlineEntry(entries, 1)?.path, 'model');
  assert.equal(resolveProviderConfigOutlineEntry(entries, 4)?.path, 'mcp_servers.demo.command');
  assert.equal(resolveProviderConfigOutlineEntry(entries, 5)?.path, 'mcp_servers.demo.args');
  assert.equal(resolveProviderConfigOutlineEntry(entries, 8)?.path, 'profiles.fast mode.model');
});

test('yaml outline follows indentation', () => {
  const content = `model: gpt-5
statusLine:
  enabled: true
  type: command
toolPermission: always-proceed`;
  const entries = buildProviderConfigOutline(content, 'yaml');
  assert.equal(resolveProviderConfigOutlineEntry(entries, 1)?.path, 'model');
  assert.equal(resolveProviderConfigOutlineEntry(entries, 3)?.path, 'statusLine.enabled');
  assert.equal(resolveProviderConfigOutlineEntry(entries, 4)?.path, 'statusLine.type');
  assert.equal(resolveProviderConfigOutlineEntry(entries, 5)?.path, 'toolPermission');
});

test('schema matching falls back to parent paths', () => {
  const fields = [
    { path: 'model', type: 'string', description: '' },
    { path: 'model_providers', type: 'object', description: '' },
    { path: 'statusLine.enabled', type: 'boolean', description: '' }
  ];
  assert.equal(findProviderConfigSchemaField(fields, 'model_providers.aih.name')?.path, 'model_providers');
  assert.equal(findProviderConfigSchemaField(fields, 'statusLine.enabled')?.path, 'statusLine.enabled');
  assert.equal(findProviderConfigSchemaField(fields, 'unknown.key'), null);
});

test('applying an option keeps the key line formatting and comments', () => {
  const json = `{
  "theme": "system", // keep this comment
  "model": "gpt-5"
}`;
  const jsonEntry = resolveProviderConfigOutlineEntry(buildProviderConfigOutline(json, 'json'), 2);
  assert.ok(jsonEntry);
  const jsonResult = applyProviderConfigOption(json, jsonEntry, 'dark', 'json');
  assert.equal(jsonResult.applied, true);
  assert.match(jsonResult.content, /"theme": "dark", \/\/ keep this comment/);

  const toml = `theme = "system" # keep\nmodel = "gpt-5"\n`;
  const tomlEntry = resolveProviderConfigOutlineEntry(buildProviderConfigOutline(toml, 'toml'), 1);
  assert.ok(tomlEntry);
  const tomlResult = applyProviderConfigOption(toml, tomlEntry, 'dark', 'toml');
  assert.match(tomlResult.content, /theme = dark # keep/);
  assert.match(tomlResult.content, /model = "gpt-5"/);
});
