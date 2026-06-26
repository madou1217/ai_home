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

  it('should return configured=false for codex oauth residue without usable tokens', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-'));

    try {
      const profileDir = path.join(tmpDir, 'codex', '13');
      const codexDir = path.join(profileDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(codexDir, 'settings.json'), JSON.stringify({ theme: 'dark' }, null, 2));
      fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }, null, 2));

      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs: {
          codex: { globalDir: '.codex' }
        }
      });

      const status = checkStatus('codex', profileDir);
      assert.equal(status.configured, false);
      assert.equal(status.accountName, 'Unknown');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return configured=false for codex oauth residue with refresh token only', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-'));

    try {
      const profileDir = path.join(tmpDir, 'codex', '14');
      const codexDir = path.join(profileDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          refresh_token: 'rt_only'
        }
      }, null, 2));

      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs: {
          codex: { globalDir: '.codex' }
        }
      });

      const status = checkStatus('codex', profileDir);
      assert.equal(status.configured, false);
      assert.equal(status.accountName, 'Unknown');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should read codex email from access token profile claim when id token is absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-'));

    try {
      const profileDir = path.join(tmpDir, 'codex', '15');
      const codexDir = path.join(profileDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      const payload = Buffer.from(JSON.stringify({
        'https://api.openai.com/profile': {
          email: 'access-only@example.com'
        }
      })).toString('base64url');
      const accessToken = `aaa.${payload}.bbb`;
      fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: accessToken
        }
      }, null, 2));

      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs: {
          codex: { globalDir: '.codex' }
        }
      });

      const status = checkStatus('codex', profileDir);
      assert.equal(status.configured, true);
      assert.equal(status.accountName, 'access-only@example.com');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return configured=false for claude oauth residue with refresh token only', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-'));

    try {
      const profileDir = path.join(tmpDir, 'claude', '1');
      const claudeDir = path.join(profileDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({
        claudeAiOauth: {
          refreshToken: 'refresh_only'
        }
      }, null, 2));

      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs: {
          claude: { globalDir: '.claude' }
        }
      });

      const status = checkStatus('claude', profileDir);
      assert.equal(status.configured, false);
      assert.equal(status.accountName, 'Unknown');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should fall back to the macOS keychain for claude when no credentials file exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-'));

    try {
      // Native macOS `claude` login stores OAuth in the login Keychain, leaving
      // <profile>/.claude without a .credentials.json — the account is still
      // logged in and must not be nagged for "no login state".
      const profileDir = path.join(tmpDir, 'claude', '4');
      const claudeDir = path.join(profileDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });

      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs: { claude: { globalDir: '.claude' } },
        readClaudeKeychain: () => ({
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-KEYCHAINTOKEN',
            refreshToken: 'sk-ant-ort01-KEYCHAINREFRESH',
            subscriptionType: 'pro'
          }
        })
      });

      const status = checkStatus('claude', profileDir);
      assert.equal(status.configured, true);
      assert.notEqual(status.accountName, 'Unknown');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should not consult the keychain when a claude credentials file is present', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-'));

    try {
      const profileDir = path.join(tmpDir, 'claude', '5');
      const claudeDir = path.join(profileDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      // A refresh-only residue file is intentionally treated as not configured;
      // the keychain fallback must not override that.
      fs.writeFileSync(path.join(claudeDir, '.credentials.json'), JSON.stringify({
        claudeAiOauth: { refreshToken: 'refresh_only' }
      }, null, 2));

      let keychainCalls = 0;
      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs: { claude: { globalDir: '.claude' } },
        readClaudeKeychain: () => {
          keychainCalls += 1;
          return { claudeAiOauth: { accessToken: 'sk-ant-oat01-SHOULD-NOT-WIN' } };
        }
      });

      const status = checkStatus('claude', profileDir);
      assert.equal(status.configured, false);
      assert.equal(keychainCalls, 0, 'keychain must not be read when a credentials file exists');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should recognize gemini oauth only when oauth_creds has usable tokens', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-'));

    try {
      const profileDir = path.join(tmpDir, 'gemini', '1');
      const geminiDir = path.join(profileDir, '.gemini');
      fs.mkdirSync(geminiDir, { recursive: true });
      fs.writeFileSync(path.join(geminiDir, 'oauth_creds.json'), JSON.stringify({
        access_token: 'gem_access_token',
        refresh_token: 'gem_refresh_token'
      }, null, 2));

      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs: {
          gemini: { globalDir: '.gemini' }
        }
      });

      const status = checkStatus('gemini', profileDir);
      assert.equal(status.configured, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return configured=false for codex oauth residue with id token only', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-'));

    try {
      const profileDir = path.join(tmpDir, 'codex', '15');
      const codexDir = path.join(profileDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(codexDir, 'auth.json'), JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6InJlc2lkdWVAZXhhbXBsZS5jb20ifQ.test'
        }
      }, null, 2));

      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs: {
          codex: { globalDir: '.codex' }
        }
      });

      const status = checkStatus('codex', profileDir);
      assert.equal(status.configured, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should read agy identity from antigravity-oauth-token file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-agy-'));

    try {
      const profileDir = path.join(tmpDir, 'agy', '1');
      const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
        token: {
          access_token: 'valid_access_token',
          refresh_token: 'valid_refresh_token',
          expiry: '2999-05-30T00:00:00Z'
        },
        auth_method: 'oauth'
      }));

      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs: {
          agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' }
        }
      });

      const status = checkStatus('agy', profileDir);
      assert.equal(status.configured, true);
      assert.equal(status.accountName, 'OAuth Configured');
      assert.equal(status.hasAccessToken, true);
      assert.equal(status.hasRefreshToken, true);
      assert.equal(status.tokenExpiresAt, Date.parse('2999-05-30T00:00:00Z'));
      assert.equal(status.tokenFresh, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should return configured=false for agy settings without token files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-agy-'));

    try {
      const profileDir = path.join(tmpDir, 'agy', '2');
      const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ model: 'Gemini 3.5 Flash (High)' }, null, 2));

      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs: {
          agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' }
        }
      });

      const status = checkStatus('agy', profileDir);
      assert.equal(status.configured, false);
      assert.equal(status.accountName, 'Unknown');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should recognize agy token-based auth from .aih_env.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-agy-'));

    try {
      const profileDir = path.join(tmpDir, 'agy', '3');
      fs.mkdirSync(profileDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify({
        AGY_ACCESS_TOKEN: 'explicit_token'
      }));

      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs: {
          agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' }
        }
      });

      const status = checkStatus('agy', profileDir);
      assert.equal(status.configured, true);
      assert.equal(status.accountName, 'Access Token: expli...oken');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should preserve agy OAuth metadata when .aih_env.json supplies access token', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-status-agy-'));

    try {
      const profileDir = path.join(tmpDir, 'agy', '4');
      const configDir = path.join(profileDir, '.gemini', 'antigravity-cli');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(profileDir, '.aih_env.json'), JSON.stringify({
        AGY_ACCESS_TOKEN: 'explicit_token'
      }));
      fs.writeFileSync(path.join(configDir, 'antigravity-oauth-token'), JSON.stringify({
        token: {
          access_token: 'oauth_access_token',
          refresh_token: 'oauth_refresh_token',
          expiry: '2000-01-01T00:00:00Z'
        },
        auth_method: 'oauth'
      }));

      const checkStatus = createAccountStatusChecker({
        fs,
        path,
        BufferImpl: Buffer,
        cliConfigs: {
          agy: { globalDir: '.gemini', configSubDir: 'antigravity-cli' }
        }
      });

      const status = checkStatus('agy', profileDir);
      assert.equal(status.configured, true);
      assert.equal(status.accountName, 'OAuth Configured');
      assert.equal(status.hasAccessToken, true);
      assert.equal(status.hasRefreshToken, true);
      assert.equal(status.tokenExpiresAt, Date.parse('2000-01-01T00:00:00Z'));
      assert.equal(status.tokenFresh, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // 回归：Claude OAuth 账号必须有可区分的身份名，否则全部叫 'OAuth Configured'，
  // 会被去重逻辑误判为同一个账号，导致新登录账号被合并销毁、状态一直 pending。
  it('should give Claude OAuth accounts distinct identities (no constant accountName)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-claude-id-'));
    try {
      const checkStatus = createAccountStatusChecker({
        fs, path, BufferImpl: Buffer,
        cliConfigs: { claude: { globalDir: '.claude' } }
      });
      const writeCreds = (id, oauth) => {
        const dir = path.join(tmpDir, 'claude', id, '.claude');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
        return path.join(tmpDir, 'claude', id);
      };

      // 带邮箱 → 用邮箱
      const withEmail = checkStatus('claude', writeCreds('1', {
        accessToken: 'sk-ant-oat01-AAA', refreshToken: 'r1', account: { emailAddress: 'alice@example.com' }
      }));
      assert.equal(withEmail.configured, true);
      assert.equal(withEmail.accountName, 'alice@example.com');

      // 无邮箱、不同 token → token 指纹（彼此不同，且都不是常量）
      const tokenA = checkStatus('claude', writeCreds('2', { accessToken: 'sk-ant-oat01-XXXXXXXXXXXX', refreshToken: 'r2' }));
      const tokenB = checkStatus('claude', writeCreds('3', { accessToken: 'sk-ant-oat01-YYYYYYYYYYYY', refreshToken: 'r3' }));
      assert.equal(tokenA.configured, true);
      assert.equal(tokenB.configured, true);
      assert.notEqual(tokenA.accountName, 'OAuth Configured');
      assert.notEqual(tokenA.accountName, tokenB.accountName);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
