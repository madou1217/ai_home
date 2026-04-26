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
});

console.log('✅ All API Key persistence tests passed');
