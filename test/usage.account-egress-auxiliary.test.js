'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const createCodexUsageSnapshotDomain = require('../lib/cli/services/usage/usage-snapshot-codex');
const {
  refreshAgyUsageSnapshotForAccount
} = require('../lib/server/agy-usage-snapshot');

test('Codex 用量内置 Token 刷新使用账号绑定出口', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-usage-egress-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const { accountRef } = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'oauth:codex:usage-egress@example.com'
  });
  writeAccountNativeAuth(fs, aiHomeDir, accountRef, {
    auth: {
      tokens: {
        access_token: 'old-access-token',
        refresh_token: 'old-refresh-token'
      }
    }
  });

  const resolvedInputs = [];
  let proxyOptions = null;
  const domain = createCodexUsageSnapshotDomain({
    fs,
    path,
    processObj: {
      env: {
        AIH_SERVER_PROXY_URL: 'http://global-proxy.example:7890',
        AIH_SERVER_NO_PROXY: 'global.example'
      }
    },
    aiHomeDir,
    async resolveAccountEgressRequestOptions(input) {
      resolvedInputs.push(input);
      return {
        ok: true,
        bound: true,
        options: {
          ...input.options,
          proxyUrl: 'http://127.0.0.1:23123',
          noProxy: 'localhost,127.0.0.1,::1'
        }
      };
    }
  }, {
    fetchWithTimeoutImpl: async (_url, _init, _timeoutMs, requestOptions) => {
      proxyOptions = requestOptions;
      return {
        ok: true,
        text: async () => JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token'
        })
      };
    }
  });

  const refreshed = await domain.refreshCodexTokenForSandbox('codex', accountRef);

  assert.equal(refreshed, true);
  assert.equal(resolvedInputs.length, 1);
  assert.equal(resolvedInputs[0].provider, 'codex');
  assert.equal(resolvedInputs[0].accountRef, accountRef);
  assert.deepEqual(proxyOptions, {
    proxyUrl: 'http://127.0.0.1:23123',
    noProxy: 'localhost,127.0.0.1,::1'
  });
  const stored = readAccountNativeAuth(fs, aiHomeDir, accountRef).auth;
  assert.equal(stored.tokens.access_token, 'new-access-token');
});

test('AGY 后台用量刷新使用账号绑定出口', async () => {
  const resolvedInputs = [];
  const proxyOptions = [];
  const account = {
    provider: 'agy',
    accountRef: 'acct_01000000000000000021',
    authType: 'oauth-personal',
    accessToken: 'agy-access-token'
  };

  const snapshot = await refreshAgyUsageSnapshotForAccount({
    account,
    force: true,
    options: {
      proxyUrl: 'http://global-proxy.example:7890',
      noProxy: 'global.example'
    },
    async resolveAccountEgressRequestOptions(input) {
      resolvedInputs.push(input);
      return {
        ok: true,
        bound: true,
        options: {
          ...input.options,
          proxyUrl: 'http://127.0.0.1:23124',
          noProxy: 'localhost,127.0.0.1,::1'
        }
      };
    },
    fetchWithTimeout: async (url, _init, _timeoutMs, requestOptions) => {
      proxyOptions.push(requestOptions);
      if (String(url).includes(':loadCodeAssist')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            cloudaicompanionProject: 'projects/agy-egress',
            paidTier: { name: 'Google AI Pro' }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          models: {
            'claude-sonnet-4-6': {
              quotaInfo: {
                remainingFraction: 0.75,
                resetTime: new Date(Date.now() + 3600_000).toISOString()
              }
            }
          }
        })
      };
    }
  });

  assert.ok(snapshot);
  assert.equal(resolvedInputs.length, 1);
  assert.equal(resolvedInputs[0].provider, 'agy');
  assert.equal(resolvedInputs[0].accountRef, account.accountRef);
  assert.ok(proxyOptions.length >= 1);
  assert.deepEqual(Array.from(new Set(proxyOptions.map((value) => JSON.stringify(value)))), [
    JSON.stringify({
      proxyUrl: 'http://127.0.0.1:23124',
      noProxy: 'localhost,127.0.0.1,::1'
    })
  ]);
});
