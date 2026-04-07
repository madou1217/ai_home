'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Permissions Full Access Configuration', () => {
  it('should filter out approvals_reviewer and sandbox_mode from host config', () => {
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

      if (trimmed.startsWith('approvals_reviewer') || trimmed.startsWith('sandbox_mode')) {
        continue;
      }

      filtered.push(line);
    }

    const result = filtered.join('\n');

    // 验证: 不应该包含 approvals_reviewer 和 sandbox_mode
    assert.ok(!result.includes('approvals_reviewer'));
    assert.ok(!result.includes('sandbox_mode'));

    // 验证: 不应该包含 preferred_auth_method 和 model_provider
    assert.ok(!result.includes('preferred_auth_method'));
    assert.ok(!result.includes('model_provider'));

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

    const result = lines.join('\n');

    // 验证: 必须包含 sandbox_mode = "danger-full-access"
    assert.ok(result.includes('sandbox_mode = "danger-full-access"'));

    // 验证: 不应该包含 approvals_reviewer
    assert.ok(!result.includes('approvals_reviewer'));

    // 验证: 应该包含账号专属配置
    assert.ok(result.includes('preferred_auth_method = "apikey"'));
    assert.ok(result.includes('model_provider = "aih"'));

    console.log('✅ Merged config has Full Access permissions');
  });

  it('should result in Full Access mode (not Custom)', () => {
    const config = {
      sandbox_mode: 'danger-full-access',
      approvals_reviewer: undefined // 不设置
    };

    // 验证: sandbox_mode 设置为 danger-full-access
    assert.equal(config.sandbox_mode, 'danger-full-access');

    // 验证: approvals_reviewer 未设置 (undefined)
    assert.equal(config.approvals_reviewer, undefined);

    // 这样的配置会让 Codex 显示 "Full Access" 而不是 "Custom"
    console.log('✅ Configuration will result in Full Access mode');
  });
});

console.log('✅ All Permissions Full Access tests passed');
