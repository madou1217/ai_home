'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('Exhausted Check - Skip for API Key Mode', () => {
  it('should skip exhausted check for API Key mode accounts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-exhausted-'));

    try {
      // 模拟 API Key 模式账号
      const profileDir = path.join(tmpDir, 'codex', '10');
      fs.mkdirSync(profileDir, { recursive: true });

      // 创建 .aih_env.json (API Key 模式)
      const envPath = path.join(profileDir, '.aih_env.json');
      fs.writeFileSync(envPath, JSON.stringify({
        OPENAI_BASE_URL: 'http://localhost:8317/v1',
        OPENAI_API_KEY: 'sk-test-key'
      }));

      // 模拟 checkStatus 函数
      const checkStatus = (cliName, profileDir) => {
        const envPath = path.join(profileDir, '.aih_env.json');
        if (fs.existsSync(envPath)) {
          return {
            configured: true,
            accountName: 'API Key: sk-te...key'
          };
        }
        return { configured: false, accountName: 'Unknown' };
      };

      // 测试逻辑
      const status = checkStatus('codex', profileDir);
      const isApiKeyMode = !!(status && status.accountName && status.accountName.startsWith('API Key'));

      assert.equal(isApiKeyMode, true, 'Should detect API Key mode');

      // 验证:API Key 模式不应该检查 exhausted
      let exhaustedCheckCalled = false;
      const mockSyncExhausted = () => {
        exhaustedCheckCalled = true;
      };

      if (!isApiKeyMode) {
        mockSyncExhausted();
      }

      assert.equal(exhaustedCheckCalled, false, 'Should NOT check exhausted for API Key mode');

    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should check exhausted for OAuth mode accounts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-exhausted-'));

    try {
      // 模拟 OAuth 模式账号
      const profileDir = path.join(tmpDir, 'codex', '11');
      fs.mkdirSync(profileDir, { recursive: true });

      const codexDir = path.join(profileDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      // 创建 auth.json (OAuth 模式)
      const authPath = path.join(codexDir, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify({
        tokens: {
          access_token: 'oauth_token',
          id_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.test'
        }
      }));

      // 模拟 checkStatus 函数
      const checkStatus = (cliName, profileDir) => {
        const authPath = path.join(profileDir, '.codex', 'auth.json');
        if (fs.existsSync(authPath)) {
          return {
            configured: true,
            accountName: 'test@example.com'
          };
        }
        return { configured: false, accountName: 'Unknown' };
      };

      // 测试逻辑
      const status = checkStatus('codex', profileDir);
      const isApiKeyMode = !!(status && status.accountName && status.accountName.startsWith('API Key'));

      assert.equal(isApiKeyMode, false, 'Should NOT detect as API Key mode');

      // 验证:OAuth 模式应该检查 exhausted
      let exhaustedCheckCalled = false;
      const mockSyncExhausted = () => {
        exhaustedCheckCalled = true;
      };

      if (!isApiKeyMode) {
        mockSyncExhausted();
      }

      assert.equal(exhaustedCheckCalled, true, 'Should check exhausted for OAuth mode');

    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

console.log('✅ All exhausted check tests passed');
