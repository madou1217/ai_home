'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createAccountStatusChecker } = require('../lib/cli/services/account/status');

describe('Account Status - API Key Mode', () => {
  it('should recognize API Key mode (aih_env.json) even when auth.json does not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-'));

    try {
      // 创建账号目录结构
      const profileDir = path.join(tmpDir, 'codex', '10');
      fs.mkdirSync(profileDir, { recursive: true });

      // ✅ 创建 .aih_env.json (API Key 模式)
      const envPath = path.join(profileDir, '.aih_env.json');
      const envData = {
        OPENAI_BASE_URL: 'http://localhost:8317/v1',
        OPENAI_API_KEY: 'sk-test-dummy-key-12345'
      };
      fs.writeFileSync(envPath, JSON.stringify(envData, null, 2));

      // ❌ 不创建 auth.json (模拟 API Key 模式，无 OAuth 认证)
      const codexDir = path.join(profileDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      // 创建 checkStatus 函数
      const cliConfigs = {
        codex: {
          globalDir: '.codex'
        }
      };

      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs
      });

      // ✅ 验证：应该被识别为已配置 (API Key 模式)
      const status = checkStatus('codex', profileDir);

      assert.ok(status, 'Status should be returned');
      assert.equal(status.configured, true, 'Should be configured when .aih_env.json exists');
      assert.ok(
        status.accountName.startsWith('API Key'),
        `Account name should start with "API Key", got: ${status.accountName}`
      );

    } finally {
      // 清理临时目录
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should prioritize OAuth auth.json over API Key mode when both exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-'));

    try {
      const profileDir = path.join(tmpDir, 'codex', '11');
      fs.mkdirSync(profileDir, { recursive: true });

      // 创建 .aih_env.json
      const envPath = path.join(profileDir, '.aih_env.json');
      const envData = {
        OPENAI_BASE_URL: 'http://localhost:8317/v1',
        OPENAI_API_KEY: 'sk-test-key'
      };
      fs.writeFileSync(envPath, JSON.stringify(envData, null, 2));

      // ✅ 同时创建 auth.json (OAuth 模式)
      const codexDir = path.join(profileDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      const authPath = path.join(codexDir, 'auth.json');
      const authData = {
        tokens: {
          access_token: 'oauth_access_token_123',
          id_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.test',
          refresh_token: 'refresh_token_456'
        }
      };
      fs.writeFileSync(authPath, JSON.stringify(authData, null, 2));

      const cliConfigs = {
        codex: {
          globalDir: '.codex'
        }
      };

      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs
      });

      // ✅ 验证：应该优先使用 OAuth 信息
      const status = checkStatus('codex', profileDir);

      assert.ok(status, 'Status should be returned');
      assert.equal(status.configured, true, 'Should be configured');
      // OAuth 应该提取 email，而不是显示 "API Key"
      assert.notEqual(
        status.accountName,
        'API Key Configured',
        'Should not show API Key when OAuth is available'
      );

    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return configured=false when neither .aih_env.json nor auth.json exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-'));

    try {
      const profileDir = path.join(tmpDir, 'codex', '12');
      fs.mkdirSync(profileDir, { recursive: true });

      // ❌ 不创建任何配置文件
      const codexDir = path.join(profileDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      const cliConfigs = {
        codex: {
          globalDir: '.codex'
        }
      };

      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs
      });

      // ✅ 验证：应该显示未配置
      const status = checkStatus('codex', profileDir);

      assert.ok(status, 'Status should be returned');
      assert.equal(status.configured, false, 'Should not be configured when no config exists');

    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
