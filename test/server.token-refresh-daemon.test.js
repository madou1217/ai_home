'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTokenRefreshDaemon } = require('../lib/server/token-refresh-daemon');

describe('createTokenRefreshDaemon', () => {
  it('should create daemon with stats', () => {
    const state = {
      accounts: {
        codex: [],
        gemini: [],
        claude: []
      }
    };

    const options = {
      tokenRefreshIntervalMs: 60000,
      tokenRefreshBeforeExpiryMs: 300000
    };

    const mockFetch = async () => ({
      ok: true,
      text: async () => '{"access_token": "mock_token", "expires_in": 3600}'
    });

    const daemon = createTokenRefreshDaemon(state, options, {
      fetchWithTimeout: mockFetch,
      logInfo: () => {},
      logWarn: () => {},
      logError: () => {}
    });

    const stats = daemon.getStats();
    assert.equal(stats.refreshIntervalMs, 60000);
    assert.equal(stats.skewMs, 300000);
    assert.equal(typeof stats.tickCount, 'number');
    assert.equal(typeof stats.totalRefreshed, 'number');
    assert.equal(typeof stats.totalErrors, 'number');

    daemon.stop();
  });

  it('should handle empty accounts gracefully', async () => {
    const state = {
      accounts: {
        codex: [],
        gemini: [],
        claude: []
      }
    };

    const options = {};
    const logs = [];

    const mockFetch = async () => ({
      ok: true,
      text: async () => '{"access_token": "mock_token", "expires_in": 3600}'
    });

    const daemon = createTokenRefreshDaemon(state, options, {
      fetchWithTimeout: mockFetch,
      logInfo: (msg) => logs.push({ level: 'info', msg }),
      logWarn: (msg) => logs.push({ level: 'warn', msg }),
      logError: (msg) => logs.push({ level: 'error', msg })
    });

    // 等待启动任务完成
    await new Promise(resolve => setTimeout(resolve, 100));

    daemon.stop();

    // 应该至少有一条完成日志
    const completedLogs = logs.filter(l => l.msg.includes('completed'));
    assert.ok(completedLogs.length > 0);
  });

  it('should refresh codex accounts when needed', async () => {
    const nowMs = Date.now();
    const expiresAt = nowMs + 2 * 60 * 1000; // 2 分钟后过期

    const mockAccount = {
      id: '1',
      provider: 'codex',
      refreshToken: 'rt_mock_refresh_token',
      accessToken: 'mock_access_token',
      tokenExpiresAt: expiresAt,
      codexAuthPath: '/tmp/nonexistent/auth.json'
    };

    const state = {
      accounts: {
        codex: [mockAccount],
        gemini: [],
        claude: []
      }
    };

    const options = {
      tokenRefreshIntervalMs: 60000,
      tokenRefreshBeforeExpiryMs: 5 * 60 * 1000 // 提前 5 分钟刷新
    };

    let refreshCalled = false;
    const mockFetch = async (url, opts) => {
      if (url.includes('oauth/token')) {
        refreshCalled = true;
        return {
          ok: true,
          text: async () => JSON.stringify({
            access_token: 'new_mock_token',
            refresh_token: 'rt_new_refresh',
            expires_in: 3600
          })
        };
      }
      return { ok: false, text: async () => '' };
    };

    const logs = [];
    const daemon = createTokenRefreshDaemon(state, options, {
      fetchWithTimeout: mockFetch,
      logInfo: (msg) => logs.push({ level: 'info', msg }),
      logWarn: (msg) => logs.push({ level: 'warn', msg }),
      logError: (msg) => logs.push({ level: 'error', msg })
    });

    // 等待启动任务完成
    await new Promise(resolve => setTimeout(resolve, 200));

    daemon.stop();

    // 验证刷新是否被调用
    assert.ok(refreshCalled, 'Token refresh should be called for expiring token');
  });

  it('should not refresh if token is far from expiry', async () => {
    const nowMs = Date.now();
    const expiresAt = nowMs + 60 * 60 * 1000; // 1 小时后过期

    const mockAccount = {
      id: '1',
      provider: 'codex',
      refreshToken: 'rt_mock_refresh_token',
      accessToken: 'mock_access_token',
      tokenExpiresAt: expiresAt,
      codexAuthPath: '/tmp/nonexistent/auth.json'
    };

    const state = {
      accounts: {
        codex: [mockAccount],
        gemini: [],
        claude: []
      }
    };

    const options = {
      tokenRefreshIntervalMs: 60000,
      tokenRefreshBeforeExpiryMs: 5 * 60 * 1000 // 提前 5 分钟刷新
    };

    let refreshCalled = false;
    const mockFetch = async (url) => {
      if (url.includes('oauth/token')) {
        refreshCalled = true;
      }
      return { ok: false, text: async () => '' };
    };

    const daemon = createTokenRefreshDaemon(state, options, {
      fetchWithTimeout: mockFetch,
      logInfo: () => {},
      logWarn: () => {},
      logError: () => {}
    });

    // 等待启动任务完成
    await new Promise(resolve => setTimeout(resolve, 200));

    daemon.stop();

    // 验证刷新不应该被调用
    assert.ok(!refreshCalled, 'Token refresh should not be called for healthy token');
  });
});
