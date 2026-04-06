'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { refreshCodexAccessToken } = require('../lib/server/codex-token-refresh');
const { refreshGeminiAccessToken } = require('../lib/server/gemini-token-refresh');
const { refreshClaudeAccessToken } = require('../lib/server/claude-token-refresh');

describe('Multi-Account Isolation', () => {
  it('should isolate Codex accounts by ID - concurrent refresh does not cross-contaminate', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-'));

    try {
      // 创建两个独立的账号配置
      const account1Dir = path.join(tmpDir, 'codex', '1', '.codex');
      const account2Dir = path.join(tmpDir, 'codex', '2', '.codex');

      fs.mkdirSync(account1Dir, { recursive: true });
      fs.mkdirSync(account2Dir, { recursive: true });

      const auth1Path = path.join(account1Dir, 'auth.json');
      const auth2Path = path.join(account2Dir, 'auth.json');

      // 初始化账号 1 的配置
      const auth1Data = {
        tokens: {
          access_token: 'old_token_account_1',
          refresh_token: 'rt_refresh_1',
          id_token: 'id_token_1',
          account_id: 'acc_1'
        },
        last_refresh: '2026-01-01T00:00:00.000Z'
      };

      // 初始化账号 2 的配置
      const auth2Data = {
        tokens: {
          access_token: 'old_token_account_2',
          refresh_token: 'rt_refresh_2',
          id_token: 'id_token_2',
          account_id: 'acc_2'
        },
        last_refresh: '2026-01-01T00:00:00.000Z'
      };

      fs.writeFileSync(auth1Path, JSON.stringify(auth1Data, null, 2));
      fs.writeFileSync(auth2Path, JSON.stringify(auth2Data, null, 2));

      // 创建账号对象（模拟 loadCodexServerAccounts 的输出）
      const nowMs = Date.now();
      const expiresAt = nowMs + 2 * 60 * 1000; // 2 分钟后过期

      const account1 = {
        id: '1',
        provider: 'codex',
        refreshToken: 'rt_refresh_1',
        accessToken: 'old_token_account_1',
        tokenExpiresAt: expiresAt,
        codexAuthPath: auth1Path
      };

      const account2 = {
        id: '2',
        provider: 'codex',
        refreshToken: 'rt_refresh_2',
        accessToken: 'old_token_account_2',
        tokenExpiresAt: expiresAt,
        codexAuthPath: auth2Path
      };

      // Mock fetch 函数 - 根据 refresh_token 返回不同的 access_token
      const mockFetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        const refreshToken = body.refresh_token;

        let newAccessToken;
        if (refreshToken === 'rt_refresh_1') {
          newAccessToken = 'NEW_TOKEN_ACCOUNT_1';
        } else if (refreshToken === 'rt_refresh_2') {
          newAccessToken = 'NEW_TOKEN_ACCOUNT_2';
        } else {
          newAccessToken = 'UNKNOWN_TOKEN';
        }

        return {
          ok: true,
          text: async () => JSON.stringify({
            access_token: newAccessToken,
            refresh_token: refreshToken,
            expires_in: 3600
          })
        };
      };

      // ✅ 并发刷新两个账号
      const [result1, result2] = await Promise.all([
        refreshCodexAccessToken(account1, {
          force: true,
          timeoutMs: 5000
        }, { fetchWithTimeout: mockFetch }),
        refreshCodexAccessToken(account2, {
          force: true,
          timeoutMs: 5000
        }, { fetchWithTimeout: mockFetch })
      ]);

      // 验证刷新结果
      assert.ok(result1.ok, 'Account 1 refresh should succeed');
      assert.ok(result1.refreshed, 'Account 1 should be refreshed');
      assert.ok(result2.ok, 'Account 2 refresh should succeed');
      assert.ok(result2.refreshed, 'Account 2 should be refreshed');

      // ✅ 验证文件隔离：读取刷新后的配置文件
      const refreshedAuth1 = JSON.parse(fs.readFileSync(auth1Path, 'utf8'));
      const refreshedAuth2 = JSON.parse(fs.readFileSync(auth2Path, 'utf8'));

      // ✅ 验证账号 1 的 token 只更新了账号 1 的文件
      assert.equal(
        refreshedAuth1.tokens.access_token,
        'NEW_TOKEN_ACCOUNT_1',
        'Account 1 should have its own new token'
      );
      assert.equal(
        refreshedAuth1.tokens.refresh_token,
        'rt_refresh_1',
        'Account 1 refresh token should remain the same'
      );

      // ✅ 验证账号 2 的 token 只更新了账号 2 的文件
      assert.equal(
        refreshedAuth2.tokens.access_token,
        'NEW_TOKEN_ACCOUNT_2',
        'Account 2 should have its own new token'
      );
      assert.equal(
        refreshedAuth2.tokens.refresh_token,
        'rt_refresh_2',
        'Account 2 refresh token should remain the same'
      );

      // ✅ 验证账号 1 没有被账号 2 的数据污染
      assert.notEqual(
        refreshedAuth1.tokens.access_token,
        refreshedAuth2.tokens.access_token,
        'Account 1 and 2 should have different tokens'
      );

      // ✅ 验证 last_refresh 时间都被更新
      assert.notEqual(
        refreshedAuth1.last_refresh,
        '2026-01-01T00:00:00.000Z',
        'Account 1 last_refresh should be updated'
      );
      assert.notEqual(
        refreshedAuth2.last_refresh,
        '2026-01-01T00:00:00.000Z',
        'Account 2 last_refresh should be updated'
      );

    } finally {
      // 清理临时目录
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should isolate Gemini accounts by ID - different config dirs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-gemini-'));

    try {
      const account1ConfigDir = path.join(tmpDir, 'gemini', '1', '.gemini');
      const account2ConfigDir = path.join(tmpDir, 'gemini', '2', '.gemini');

      fs.mkdirSync(account1ConfigDir, { recursive: true });
      fs.mkdirSync(account2ConfigDir, { recursive: true });

      const oauth1Path = path.join(account1ConfigDir, 'oauth_creds.json');
      const oauth2Path = path.join(account2ConfigDir, 'oauth_creds.json');

      // 初始化账号配置
      const oauth1Data = {
        access_token: 'old_gemini_token_1',
        refresh_token: 'gemini_refresh_1',
        client_id: 'client_1',
        client_secret: 'secret_1',
        expires_at: Date.now() + 2 * 60 * 1000
      };

      const oauth2Data = {
        access_token: 'old_gemini_token_2',
        refresh_token: 'gemini_refresh_2',
        client_id: 'client_2',
        client_secret: 'secret_2',
        expires_at: Date.now() + 2 * 60 * 1000
      };

      fs.writeFileSync(oauth1Path, JSON.stringify(oauth1Data, null, 2));
      fs.writeFileSync(oauth2Path, JSON.stringify(oauth2Data, null, 2));

      const account1 = {
        id: '1',
        provider: 'gemini',
        authType: 'oauth-personal',
        configDir: account1ConfigDir,
        accessToken: 'old_gemini_token_1',
        tokenExpiresAt: oauth1Data.expires_at
      };

      const account2 = {
        id: '2',
        provider: 'gemini',
        authType: 'oauth-personal',
        configDir: account2ConfigDir,
        accessToken: 'old_gemini_token_2',
        tokenExpiresAt: oauth2Data.expires_at
      };

      const mockFetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        const refreshToken = body.refresh_token;

        let newAccessToken;
        if (refreshToken === 'gemini_refresh_1') {
          newAccessToken = 'NEW_GEMINI_TOKEN_1';
        } else if (refreshToken === 'gemini_refresh_2') {
          newAccessToken = 'NEW_GEMINI_TOKEN_2';
        } else {
          newAccessToken = 'UNKNOWN';
        }

        return {
          ok: true,
          text: async () => JSON.stringify({
            access_token: newAccessToken,
            expires_in: 3600
          })
        };
      };

      // 并发刷新
      await Promise.all([
        refreshGeminiAccessToken(account1, { force: true }, { fetchWithTimeout: mockFetch }),
        refreshGeminiAccessToken(account2, { force: true }, { fetchWithTimeout: mockFetch })
      ]);

      // 验证隔离
      const refreshed1 = JSON.parse(fs.readFileSync(oauth1Path, 'utf8'));
      const refreshed2 = JSON.parse(fs.readFileSync(oauth2Path, 'utf8'));

      assert.equal(refreshed1.access_token, 'NEW_GEMINI_TOKEN_1');
      assert.equal(refreshed2.access_token, 'NEW_GEMINI_TOKEN_2');
      assert.notEqual(refreshed1.access_token, refreshed2.access_token);

    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should isolate different providers with same ID', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-cross-'));

    try {
      // 创建 codex#1 和 gemini#1（相同 ID，不同 provider）
      const codexDir = path.join(tmpDir, 'codex', '1', '.codex');
      const geminiDir = path.join(tmpDir, 'gemini', '1', '.gemini');

      fs.mkdirSync(codexDir, { recursive: true });
      fs.mkdirSync(geminiDir, { recursive: true });

      const codexAuthPath = path.join(codexDir, 'auth.json');
      const geminiOAuthPath = path.join(geminiDir, 'oauth_creds.json');

      // 初始化配置
      const codexAuth = {
        tokens: {
          access_token: 'codex_token',
          refresh_token: 'rt_codex_refresh',
          id_token: 'id_token',
          account_id: 'acc_1'
        }
      };

      const geminiOAuth = {
        access_token: 'gemini_token',
        refresh_token: 'gemini_refresh',
        client_id: 'client',
        client_secret: 'secret',
        expires_at: Date.now() + 2 * 60 * 1000
      };

      fs.writeFileSync(codexAuthPath, JSON.stringify(codexAuth, null, 2));
      fs.writeFileSync(geminiOAuthPath, JSON.stringify(geminiOAuth, null, 2));

      const codexAccount = {
        id: '1',
        provider: 'codex',
        refreshToken: 'rt_codex_refresh',
        codexAuthPath: codexAuthPath,
        tokenExpiresAt: Date.now() + 2 * 60 * 1000
      };

      const geminiAccount = {
        id: '1',
        provider: 'gemini',
        authType: 'oauth-personal',
        configDir: geminiDir,
        tokenExpiresAt: geminiOAuth.expires_at
      };

      const mockFetch = async (url, opts) => {
        return {
          ok: true,
          text: async () => JSON.stringify({
            access_token: 'NEW_TOKEN',
            refresh_token: 'rt_new',
            expires_in: 3600
          })
        };
      };

      // 同时刷新两个不同 provider 的账号（都是 ID=1）
      await Promise.all([
        refreshCodexAccessToken(codexAccount, { force: true }, { fetchWithTimeout: mockFetch }),
        refreshGeminiAccessToken(geminiAccount, { force: true }, { fetchWithTimeout: mockFetch })
      ]);

      // ✅ 验证：即使 ID 相同，不同 provider 的配置完全隔离
      const refreshedCodex = JSON.parse(fs.readFileSync(codexAuthPath, 'utf8'));
      const refreshedGemini = JSON.parse(fs.readFileSync(geminiOAuthPath, 'utf8'));

      // 两者都应该成功更新
      assert.equal(refreshedCodex.tokens.access_token, 'NEW_TOKEN');
      assert.equal(refreshedGemini.access_token, 'NEW_TOKEN');

      // 验证配置结构不同（Codex 有 tokens 嵌套，Gemini 是扁平结构）
      assert.ok(refreshedCodex.tokens, 'Codex should have tokens object');
      assert.ok(!refreshedGemini.tokens, 'Gemini should not have tokens object');

    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
