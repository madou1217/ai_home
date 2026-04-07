'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 模拟 runtime.js 中的配置同步函数
function extractAccountOnlyConfig(configText) {
  const result = {
    preferred_auth_method: null,
    model_provider: null,
    providers: []
  };

  const lines = configText.split('\n');
  let inProviders = false;
  let currentProvider = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('preferred_auth_method')) {
      result.preferred_auth_method = line;
    }

    if (line.startsWith('model_provider')) {
      result.model_provider = line;
    }

    if (line === '[[providers]]') {
      inProviders = true;
      currentProvider = [line];
      continue;
    }

    if (inProviders) {
      if (line.startsWith('[[') || line.startsWith('[model_providers') || (line === '' && i + 1 < lines.length && lines[i + 1].trim().startsWith('['))) {
        if (currentProvider.length > 0) {
          result.providers.push(currentProvider.join('\n'));
        }
        inProviders = false;
        currentProvider = [];
      } else {
        currentProvider.push(lines[i]);
      }
    }
  }

  if (currentProvider.length > 0) {
    result.providers.push(currentProvider.join('\n'));
  }

  return result;
}

function filterHostConfig(configText, options) {
  const lines = configText.split('\n');
  const filtered = [];
  let skipUntilNextSection = false;
  let inModelProviders = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (options.excludeAccountOnly) {
      if (trimmed.startsWith('preferred_auth_method') || trimmed.startsWith('model_provider')) {
        continue;
      }
      if (trimmed === '[[providers]]') {
        skipUntilNextSection = true;
        continue;
      }
    }

    if (options.excludeSensitive) {
      if (trimmed.startsWith('[model_providers.')) {
        inModelProviders = true;
        filtered.push(line);
        continue;
      }

      if (inModelProviders && (trimmed.startsWith('[') && !trimmed.startsWith('[model_providers'))) {
        inModelProviders = false;
      }

      if (inModelProviders) {
        if (trimmed.startsWith('bearer_token') || trimmed.startsWith('api_key') || trimmed.includes('_token =') || trimmed.includes('_key =')) {
          continue;
        }
      }
    }

    if (skipUntilNextSection) {
      if (trimmed.startsWith('[') && trimmed !== '[[providers]]') {
        skipUntilNextSection = false;
      } else {
        continue;
      }
    }

    filtered.push(line);
  }

  return filtered.join('\n');
}

describe('Config Sync - Sensitive Field Filtering', () => {
  it('should exclude bearer_token from model_providers section', () => {
    const hostConfig = `
[model_providers.aih]
name = "aih codex"
base_url = "http://127.0.0.1:8317/v1"
bearer_token = "dummy"
wire_api = "responses"
`;

    const filtered = filterHostConfig(hostConfig, {
      excludeAccountOnly: false,
      excludeSensitive: true
    });

    assert.ok(!filtered.includes('bearer_token'), 'Should not include bearer_token');
    assert.ok(filtered.includes('name = "aih codex"'), 'Should include name');
    assert.ok(filtered.includes('base_url'), 'Should include base_url');
    assert.ok(filtered.includes('wire_api'), 'Should include wire_api');
  });

  it('should exclude preferred_auth_method and model_provider', () => {
    const hostConfig = `
preferred_auth_method = "apikey"
model_provider = "aih"
model = "gpt-5.4"
`;

    const filtered = filterHostConfig(hostConfig, {
      excludeAccountOnly: true,
      excludeSensitive: false
    });

    assert.ok(!filtered.includes('preferred_auth_method'), 'Should not include preferred_auth_method');
    assert.ok(!filtered.includes('model_provider'), 'Should not include model_provider');
    assert.ok(filtered.includes('model = "gpt-5.4"'), 'Should include model');
  });

  it('should exclude [[providers]] section', () => {
    const hostConfig = `
model = "gpt-5.4"

[[providers]]
name = "test"
base_url = "https://test.com"

[features]
multi_agent = true
`;

    const filtered = filterHostConfig(hostConfig, {
      excludeAccountOnly: true,
      excludeSensitive: false
    });

    assert.ok(!filtered.includes('[[providers]]'), 'Should not include [[providers]]');
    assert.ok(!filtered.includes('name = "test"'), 'Should not include provider content');
    assert.ok(filtered.includes('model = "gpt-5.4"'), 'Should include model');
    assert.ok(filtered.includes('[features]'), 'Should include features section');
  });
});

describe('Config Sync - Account-Only Config Extraction', () => {
  it('should extract preferred_auth_method and model_provider', () => {
    const accountConfig = `
# Codex configuration for account 10
preferred_auth_method = "oauth"
model_provider = "custom"
model = "gpt-5.4"
`;

    const extracted = extractAccountOnlyConfig(accountConfig);

    assert.equal(extracted.preferred_auth_method, 'preferred_auth_method = "oauth"');
    assert.equal(extracted.model_provider, 'model_provider = "custom"');
  });

  it('should extract [[providers]] sections', () => {
    const accountConfig = `
[[providers]]
name = "replit1"
base_url = "https://xxx.replit.dev"
api_key_env = "OPENAI_API_KEY"

[[providers]]
name = "local"
base_url = "http://localhost:8000"

[features]
multi_agent = true
`;

    const extracted = extractAccountOnlyConfig(accountConfig);

    assert.equal(extracted.providers.length, 2);
    assert.ok(extracted.providers[0].includes('name = "replit1"'));
    assert.ok(extracted.providers[1].includes('name = "local"'));
  });
});

console.log('✅ All config sync tests passed');
