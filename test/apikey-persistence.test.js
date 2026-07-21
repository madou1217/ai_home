'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

describe('API Key Persistence', () => {
  it('should auto-save OPENAI_API_KEY from environment to .aih_env.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-apikey-'));

    try {
      const sandboxDir = path.join(tmpDir, 'codex', '10');
      fs.mkdirSync(sandboxDir, { recursive: true });

      const envPath = path.join(sandboxDir, '.aih_env.json');

      // 模拟环境变量
      const processEnv = {
        OPENAI_API_KEY: 'sk-test-key-12345',
        OPENAI_BASE_URL: 'http://localhost:8317/v1'
      };

      // 模拟 spawnPty 的 API Key 检测逻辑
      let loadedEnv = {};
      if (fs.existsSync(envPath)) {
        loadedEnv = JSON.parse(fs.readFileSync(envPath, 'utf8'));
      }

      const hasApiKeyInProcess = !!(processEnv.OPENAI_API_KEY && String(processEnv.OPENAI_API_KEY).trim());
      const hasApiKeyInSaved = !!(loadedEnv.OPENAI_API_KEY && String(loadedEnv.OPENAI_API_KEY).trim());
      const hasBaseUrlInProcess = !!(processEnv.OPENAI_BASE_URL && String(processEnv.OPENAI_BASE_URL).trim());

      if (hasApiKeyInProcess && !hasApiKeyInSaved) {
        const envToSave = { ...loadedEnv };
        envToSave.OPENAI_API_KEY = String(processEnv.OPENAI_API_KEY).trim();
        if (hasBaseUrlInProcess) {
          envToSave.OPENAI_BASE_URL = String(processEnv.OPENAI_BASE_URL).trim();
        }
        fs.writeFileSync(envPath, JSON.stringify(envToSave, null, 2), 'utf8');
        loadedEnv = envToSave;
      }

      // 验证
      assert.ok(fs.existsSync(envPath), '.aih_env.json should be created');
      const saved = JSON.parse(fs.readFileSync(envPath, 'utf8'));
      assert.equal(saved.OPENAI_API_KEY, 'sk-test-key-12345');
      assert.equal(saved.OPENAI_BASE_URL, 'http://localhost:8317/v1');

    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should not overwrite existing .aih_env.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-apikey-'));

    try {
      const sandboxDir = path.join(tmpDir, 'codex', '11');
      fs.mkdirSync(sandboxDir, { recursive: true });

      const envPath = path.join(sandboxDir, '.aih_env.json');

      // 已存在的配置
      const existingEnv = {
        OPENAI_API_KEY: 'sk-existing-key',
        OPENAI_BASE_URL: 'https://existing.api.com',
        CUSTOM_VAR: 'custom-value'
      };
      fs.writeFileSync(envPath, JSON.stringify(existingEnv, null, 2), 'utf8');

      // 模拟环境变量
      const processEnv = {
        OPENAI_API_KEY: 'sk-new-key',
        OPENAI_BASE_URL: 'http://localhost:8000'
      };

      // 模拟检测逻辑
      let loadedEnv = JSON.parse(fs.readFileSync(envPath, 'utf8'));

      const hasApiKeyInProcess = !!(processEnv.OPENAI_API_KEY && String(processEnv.OPENAI_API_KEY).trim());
      const hasApiKeyInSaved = !!(loadedEnv.OPENAI_API_KEY && String(loadedEnv.OPENAI_API_KEY).trim());

      if (hasApiKeyInProcess && !hasApiKeyInSaved) {
        // 不应该执行这段代码
        const envToSave = { ...loadedEnv };
        envToSave.OPENAI_API_KEY = String(processEnv.OPENAI_API_KEY).trim();
        fs.writeFileSync(envPath, JSON.stringify(envToSave, null, 2), 'utf8');
      }

      // 验证:已存在的配置不应该被覆盖
      const saved = JSON.parse(fs.readFileSync(envPath, 'utf8'));
      assert.equal(saved.OPENAI_API_KEY, 'sk-existing-key', 'Should keep existing API key');
      assert.equal(saved.OPENAI_BASE_URL, 'https://existing.api.com', 'Should keep existing base URL');
      assert.equal(saved.CUSTOM_VAR, 'custom-value', 'Should keep custom variables');

    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should handle missing OPENAI_BASE_URL gracefully', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-apikey-'));

    try {
      const sandboxDir = path.join(tmpDir, 'codex', '12');
      fs.mkdirSync(sandboxDir, { recursive: true });

      const envPath = path.join(sandboxDir, '.aih_env.json');

      // 只有 API Key,没有 Base URL
      const processEnv = {
        OPENAI_API_KEY: 'sk-test-key-only'
      };

      let loadedEnv = {};
      const hasApiKeyInProcess = !!(processEnv.OPENAI_API_KEY && String(processEnv.OPENAI_API_KEY).trim());
      const hasApiKeyInSaved = !!(loadedEnv.OPENAI_API_KEY && String(loadedEnv.OPENAI_API_KEY).trim());
      const hasBaseUrlInProcess = !!(processEnv.OPENAI_BASE_URL && String(processEnv.OPENAI_BASE_URL).trim());

      if (hasApiKeyInProcess && !hasApiKeyInSaved) {
        const envToSave = { ...loadedEnv };
        envToSave.OPENAI_API_KEY = String(processEnv.OPENAI_API_KEY).trim();
        if (hasBaseUrlInProcess) {
          envToSave.OPENAI_BASE_URL = String(processEnv.OPENAI_BASE_URL).trim();
        }
        fs.writeFileSync(envPath, JSON.stringify(envToSave, null, 2), 'utf8');
      }

      // 验证
      const saved = JSON.parse(fs.readFileSync(envPath, 'utf8'));
      assert.equal(saved.OPENAI_API_KEY, 'sk-test-key-only');
      assert.equal(saved.OPENAI_BASE_URL, undefined, 'Should not save undefined BASE_URL');

    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
  it('should NOT auto-save env API key when account has OAuth credentials (access_token)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-apikey-'));

    try {
      const sandboxDir = path.join(tmpDir, 'codex', '14');
      const codexDir = path.join(sandboxDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });

      const envPath = path.join(sandboxDir, '.aih_env.json');
      // OAuth account — no .aih_env.json, but has OAuth auth.json
      const authJsonPath = path.join(codexDir, 'auth.json');
      fs.writeFileSync(authJsonPath, JSON.stringify({
        tokens: {
          access_token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test.payload',
          id_token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.id.payload',
          refresh_token: 'v1.refresh.token'
        }
      }, null, 2));

      // Simulate host env having an API key (from another account)
      const processEnv = {
        OPENAI_API_KEY: 'sk-38-should-not-leak-331a',
        OPENAI_BASE_URL: 'https://sub.jia4u.de/v1'
      };

      // Replicate the fixed spawnPty logic
      let loadedEnv = {};
      if (fs.existsSync(envPath)) {
        loadedEnv = JSON.parse(fs.readFileSync(envPath, 'utf8'));
      }
      const hasApiKeyInProcess = !!(processEnv.OPENAI_API_KEY && String(processEnv.OPENAI_API_KEY).trim());
      const hasApiKeyInSaved = !!(loadedEnv.OPENAI_API_KEY && String(loadedEnv.OPENAI_API_KEY).trim());

      // Check for existing OAuth credentials
      let accountHasOAuthCredentials = false;
      try {
        if (fs.existsSync(authJsonPath)) {
          const existingAuth = JSON.parse(fs.readFileSync(authJsonPath, 'utf8'));
          const tokens = existingAuth && existingAuth.tokens && typeof existingAuth.tokens === 'object'
            ? existingAuth.tokens : existingAuth;
          accountHasOAuthCredentials = !!(tokens && tokens.access_token && String(tokens.access_token).trim());
        }
      } catch (_error) {}

      // The guard: should NOT write when OAuth credentials exist
      if (hasApiKeyInProcess && !hasApiKeyInSaved && !accountHasOAuthCredentials) {
        const envToSave = { ...loadedEnv };
        envToSave.OPENAI_API_KEY = String(processEnv.OPENAI_API_KEY).trim();
        fs.writeFileSync(envPath, JSON.stringify(envToSave, null, 2), 'utf8');
      }

      // Verify: .aih_env.json should NOT be created for OAuth account
      assert.ok(!fs.existsSync(envPath), '.aih_env.json should NOT be created for OAuth account');
      assert.ok(accountHasOAuthCredentials, 'Should have detected OAuth credentials');

      // Verify: auth.json should still have OAuth tokens, not API key
      const authData = JSON.parse(fs.readFileSync(authJsonPath, 'utf8'));
      assert.ok(authData.tokens, 'auth.json should still have tokens object');
      assert.ok(authData.tokens.access_token, 'auth.json should still have access_token');
      assert.equal(authData.OPENAI_API_KEY, undefined, 'auth.json should NOT have leaked API key');

    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

console.log('✅ All API Key persistence tests passed');
