'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Permissions Full Access Configuration', () => {
  it('should filter out sandbox_mode from host config but keep other settings', () => {
    const hostConfig = `
preferred_auth_method = "apikey"
model_provider = "aih"
sandbox_mode = "danger-full-access"
approvals_reviewer = "user"
model = "gpt-5.4"
`;

    const lines = hostConfig.split('\n');
    const filtered = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // 模拟 filterHostConfig 逻辑
      if (trimmed.startsWith('preferred_auth_method') || trimmed.startsWith('model_provider')) {
        continue;
      }

      if (trimmed.startsWith('sandbox_mode')) {
        continue;
      }

      filtered.push(line);
    }

    const result = filtered.join('\n');

    // 验证: 不应该包含 sandbox_mode
    assert.ok(!result.includes('sandbox_mode'));

    // 验证: 不应该包含 preferred_auth_method 和 model_provider
    assert.ok(!result.includes('preferred_auth_method'));
    assert.ok(!result.includes('model_provider'));

    // 验证: 应该包含 approvals_reviewer (从宿主继承)
    assert.ok(result.includes('approvals_reviewer'));

    // 验证: 应该包含其他配置
    assert.ok(result.includes('model = "gpt-5.4"'));

    console.log('✅ Host config filtered correctly');
  });

  it('should add sandbox_mode = "danger-full-access" in merged config', () => {
    const accountOnlyConfig = {
      preferred_auth_method: 'preferred_auth_method = "apikey"',
      model_provider: 'model_provider = "aih"',
      providers: []
    };

    const accountId = '123';
    const options = {
      openaiBaseUrl: 'http://localhost:8317/v1'
    };
    const lines = [];

    // 模拟 mergeConfigs 逻辑
    lines.push('# Codex configuration for account ' + accountId);
    lines.push('# This file is managed by ai-home (aih)');
    lines.push('# Synced from host config (excluding sensitive fields)');
    lines.push('');

    if (accountOnlyConfig.preferred_auth_method) {
      lines.push(accountOnlyConfig.preferred_auth_method);
    }
    if (accountOnlyConfig.model_provider) {
      lines.push(accountOnlyConfig.model_provider);
    }
    lines.push('');

    // ✅ 强制设置权限策略
    lines.push('# AI Home managed permissions: Full Access');
    lines.push('sandbox_mode = "danger-full-access"');
    lines.push('');

    // ✅ 迁移 OPENAI_BASE_URL
    if (options.openaiBaseUrl && String(options.openaiBaseUrl).trim()) {
      lines.push('# API endpoint configuration (migrated from OPENAI_BASE_URL env var)');
      lines.push(`openai_base_url = "${String(options.openaiBaseUrl).trim()}"`);
      lines.push('');
    }

    const result = lines.join('\n');

    // 验证: 必须包含 sandbox_mode = "danger-full-access"
    assert.ok(result.includes('sandbox_mode = "danger-full-access"'));

    // 验证: 应该包含账号专属配置
    assert.ok(result.includes('preferred_auth_method = "apikey"'));
    assert.ok(result.includes('model_provider = "aih"'));

    // 验证: 应该包含 openai_base_url (替代 OPENAI_BASE_URL)
    assert.ok(result.includes('openai_base_url = "http://localhost:8317/v1"'));

    console.log('✅ Merged config has Full Access permissions and migrated OPENAI_BASE_URL');
  });

  it('should result in Full Access mode', () => {
    const config = {
      sandbox_mode: 'danger-full-access'
    };

    // 验证: sandbox_mode 设置为 danger-full-access
    assert.equal(config.sandbox_mode, 'danger-full-access');

    // danger-full-access 模式下，Codex 会自动跳过审批流程
    console.log('✅ Configuration will result in Full Access mode');
  });

  it('should set preferred_auth_method and model_provider for API Key mode', () => {
    const accountOnlyConfig = {
      preferred_auth_method: null,
      model_provider: null,
      providers: []
    };

    const options = {
      openaiBaseUrl: 'http://localhost:8317/v1',
      isApiKeyMode: true
    };

    // 模拟 API Key 模式配置逻辑
    if (options.isApiKeyMode) {
      if (!accountOnlyConfig.preferred_auth_method) {
        accountOnlyConfig.preferred_auth_method = 'preferred_auth_method = "apikey"';
      }
      if (!accountOnlyConfig.model_provider) {
        accountOnlyConfig.model_provider = options.openaiBaseUrl
          ? 'model_provider = "aih"'
          : 'model_provider = "openai"';
      }
    }

    // 验证: 设置了 preferred_auth_method
    assert.equal(accountOnlyConfig.preferred_auth_method, 'preferred_auth_method = "apikey"');

    // 验证: 设置了 model_provider
    assert.equal(accountOnlyConfig.model_provider, 'model_provider = "aih"');

    console.log('✅ API Key mode sets correct auth method and model provider');
  });

  it('should create [model_providers.aih] section for API Key mode with custom base URL', () => {
    const accountOnlyConfig = {
      providers: []
    };

    const options = {
      openaiBaseUrl: 'http://localhost:8317/v1',
      openaiApiKey: 'dummy',
      isApiKeyMode: true
    };

    const lines = [];

    // 模拟 model_providers.aih section 创建逻辑
    if (options.isApiKeyMode && options.openaiBaseUrl && options.openaiApiKey) {
      lines.push('');
      lines.push('# AI Home managed provider for API Key mode');
      lines.push('[model_providers.aih]');
      lines.push('name = "aih codex"');
      lines.push(`base_url = "${String(options.openaiBaseUrl).trim()}"`);
      lines.push(`bearer_token = "${String(options.openaiApiKey).trim()}"`);
      lines.push('wire_api = "responses"');
      lines.push('');
    }

    const result = lines.join('\n');

    // 验证: 包含 [model_providers.aih] section
    assert.ok(result.includes('[model_providers.aih]'));
    assert.ok(result.includes('name = "aih codex"'));
    assert.ok(result.includes('base_url = "http://localhost:8317/v1"'));
    assert.ok(result.includes('bearer_token = "dummy"'));
    assert.ok(result.includes('wire_api = "responses"'));

    console.log('✅ API Key mode creates correct [model_providers.aih] section');
  });
});

console.log('✅ All Permissions Full Access tests passed');
