'use strict';

// 新增账号时的「不入池」偏好：账号创建有三条入口（api-key/vertex 立即建账号、OAuth 登录
// 任务、本机登录态直接导入），三条都要能用同一个请求字段表达，且默认参与不落库。
// 领域层实现见 lib/account/alias-pool-preference.js，任务侧落库在 web-account-auth 的
// finalizeJob（账号要等作业成功才注册）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyAliasPoolPreference,
  readAliasPoolParticipates
} = require('../lib/account/alias-pool-preference');
const { readAliasPoolConfig, readAliasPoolParticipationMap } = require('../lib/account/alias-pool-store');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { handleAddAccountRequest } = require('../lib/server/webui-account-routes');
const { createAuthJobManager: createAuthJobManagerImpl } = require('../lib/server/web-account-auth');

function createTempAiHome(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createResCapture() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code;
    },
    end(chunk = '') {
      this.body = String(chunk);
    }
  };
}

function createAddAccountContext(root, payload, overrides = {}) {
  const res = createResCapture();
  return {
    res,
    ctx: {
      req: { headers: { host: 'localhost:9527' } },
      res,
      fs,
      aiHomeDir: root,
      deps: { aiHomeDir: root },
      state: {},
      readRequestBody: async () => Buffer.from(JSON.stringify(payload)),
      getProfileDir: (provider, accountRef) => path.join(root, 'run', provider, String(accountRef)),
      getToolConfigDir: (provider, accountRef) => path.join(root, 'run', provider, String(accountRef), `.${provider}`),
      cleanupAuthJobArtifacts() {},
      loadServerRuntimeAccounts: () => ({ agy: [], claude: [], codex: [], gemini: [], opencode: [] }),
      applyReloadState() {},
      checkStatus: () => ({ configured: true }),
      writeJson(response, code, body) {
        response.statusCode = code;
        response.end(JSON.stringify(body));
      },
      ...overrides
    }
  };
}

function makeJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload || {})).toString('base64url'),
    'sig'
  ].join('.');
}

function codexIdToken(userId) {
  return makeJwt({
    'https://api.openai.com/auth': { chatgpt_user_id: userId }
  });
}

test('alias pool preference defaults to participating and only an explicit false opts out', () => {
  assert.equal(readAliasPoolParticipates(null), true);
  assert.equal(readAliasPoolParticipates({}), true);
  assert.equal(readAliasPoolParticipates({ aliasPoolParticipates: true }), true);
  assert.equal(readAliasPoolParticipates({ aliasPoolParticipates: 'no' }), true, '非布尔一律按默认参与');
  assert.equal(readAliasPoolParticipates({ aliasPoolParticipates: false }), false);
});

test('applyAliasPoolPreference records only the opt-out and never throws for a stale ref', (t) => {
  const root = createTempAiHome(t, 'aih-alias-pool-pref-');
  const { accountRef } = registerAccountIdentity(fs, root, {
    provider: 'codex',
    cliAccountId: '1',
    identitySeed: 'pref:codex:1'
  });

  assert.deepEqual(applyAliasPoolPreference(fs, root, accountRef, true), { applied: false, error: '' });
  assert.equal(readAliasPoolConfig(fs, root, accountRef), null, '默认参与不落库');

  assert.deepEqual(applyAliasPoolPreference(fs, root, accountRef, false), { applied: true, error: '' });
  assert.equal(readAliasPoolConfig(fs, root, accountRef).participates, false);

  // 创建已经成功，偏好写入失败不该抛给调用方，只回报错误。
  const failed = applyAliasPoolPreference(fs, root, 'acct_ffffffffffffffffffff', false);
  assert.equal(failed.applied, false);
  assert.match(failed.error, /invalid_alias_pool_account/);
});

test('adding an api-key account with the opt-out writes the preference before the pool reload', async (t) => {
  const root = createTempAiHome(t, 'aih-add-account-opt-out-');
  const reloads = [];
  const { ctx, res } = createAddAccountContext(root, {
    provider: 'codex',
    authMode: 'api-key',
    config: { apiKey: 'sk-test', baseUrl: 'https://proxy.example.com/v1' },
    aliasPoolParticipates: false
  }, {
    loadServerRuntimeAccounts: () => {
      // 重载运行池时偏好必须已经在库里，否则这一次重载会先把它拉进别名选号池。
      reloads.push(readAliasPoolParticipationMap(fs, root));
      return { agy: [], claude: [], codex: [], gemini: [], opencode: [] };
    }
  });

  assert.equal(await handleAddAccountRequest(ctx), true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.ok(reloads.length >= 1, '建账号后仍会重载运行池');
  assert.equal(reloads[0].get(body.accountRef), false);
  assert.equal(readAliasPoolConfig(fs, root, body.accountRef).participates, false);
});

test('adding an account without the field leaves the account in the alias pool by default', async (t) => {
  const root = createTempAiHome(t, 'aih-add-account-default-pool-');
  const { ctx, res } = createAddAccountContext(root, {
    provider: 'codex',
    authMode: 'api-key',
    config: { apiKey: 'sk-test', baseUrl: 'https://proxy.example.com/v1' }
  });

  assert.equal(await handleAddAccountRequest(ctx), true);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(readAliasPoolConfig(fs, root, body.accountRef), null, '默认参与不落库');
});

test('the oauth add path hands the opt-out to the login job instead of writing it now', async (t) => {
  const root = createTempAiHome(t, 'aih-add-account-oauth-opt-out-');
  const jobOptions = [];
  const { ctx, res } = createAddAccountContext(root, {
    provider: 'codex',
    authMode: 'oauth-browser',
    aliasPoolParticipates: false
  }, {
    getAuthJobManager() {
      return {
        startOauthJobWithInstallConfirmation(provider, authMode, options) {
          jobOptions.push({ provider, authMode, options });
          return { jobId: 'job-1', provider, accountRef: '', expiresAt: null, pollIntervalMs: 5000 };
        }
      };
    }
  });

  assert.equal(await handleAddAccountRequest(ctx), true);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).jobId, 'job-1');
  assert.equal(jobOptions.length, 1);
  assert.equal(jobOptions[0].options.aliasPoolParticipates, false);
});

test('the local-import path applies the opt-out to the account it just created', async (t) => {
  const root = createTempAiHome(t, 'aih-local-import-opt-out-');
  // 本机来源解析在测试里固定为空：走 importLocalAuthSource 的默认（无插件来源）分支。
  const { handleLocalAuthSourceImportRequest } = require('../lib/server/webui-account-routes');
  const { registerAccountIdentity } = require('../lib/account/account-registration');
  const imported = registerAccountIdentity(fs, root, {
    provider: 'opencode',
    cliAccountId: '1',
    identitySeed: 'local-import:opencode:1'
  });
  const { ctx: importCtx, res: importRes } = createAddAccountContext(root, {
    provider: 'opencode',
    sourceId: 'host-account-scan',
    aliasPoolParticipates: false
  }, {
    deps: {
      aiHomeDir: root,
      importLocalAuthSource: async () => ({
        ok: true,
        accountRef: imported.accountRef,
        cliAccountId: 1,
        sourceId: 'host-account-scan'
      })
    }
  });

  await handleLocalAuthSourceImportRequest(importCtx);
  assert.equal(importRes.statusCode, 200);
  assert.equal(JSON.parse(importRes.body).accountRef, imported.accountRef);
  assert.equal(readAliasPoolConfig(fs, root, imported.accountRef).participates, false);
});

test('a succeeded oauth job records the opt-out on the account it registered', async (t) => {
  const root = createTempAiHome(t, 'aih-oauth-job-opt-out-');
  const getProfileDir = (provider, accountRef) => path.join(root, 'run', provider, String(accountRef));
  const getToolConfigDir = (provider, accountRef) => path.join(getProfileDir(provider, accountRef), `.${provider}`);
  const manager = createAuthJobManagerImpl({
    fs,
    aiHomeDir: root,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform,
      kill() {}
    },
    ptyImpl: {
      spawn() {
        throw new Error('codex browser oauth should not spawn a cli');
      }
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: 'codex-access',
        refresh_token: 'codex-refresh',
        id_token: codexIdToken('opt-out-user'),
        expires_in: 3600
      })
    }),
    startLoopbackCallbackServerImpl: (options) => {
      setImmediate(() => options.onListening({ url: options.redirectUri }));
      return { close() {} };
    },
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => ['7'],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('codex', 'oauth-browser', { aliasPoolParticipates: false });
  const running = manager.getJob(started.jobId);
  const completed = await manager.completeBrowserOauthCallback(
    started.jobId,
    `${running.redirectUri}?code=ok&state=${running.oauthState}`
  );
  assert.equal(completed.ok, true);
  const job = manager.getJob(started.jobId);
  assert.equal(job.status, 'succeeded');
  assert.match(job.accountRef, /^acct_[a-f0-9]{20}$/);
  assert.equal(readAliasPoolConfig(fs, root, job.accountRef).participates, false);
});

test('a succeeded oauth job without the field leaves the new account in the pool', async (t) => {
  const root = createTempAiHome(t, 'aih-oauth-job-default-pool-');
  const getProfileDir = (provider, accountRef) => path.join(root, 'run', provider, String(accountRef));
  const getToolConfigDir = (provider, accountRef) => path.join(getProfileDir(provider, accountRef), `.${provider}`);
  const manager = createAuthJobManagerImpl({
    fs,
    aiHomeDir: root,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform,
      kill() {}
    },
    ptyImpl: {
      spawn() {
        throw new Error('codex browser oauth should not spawn a cli');
      }
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: 'codex-access',
        refresh_token: 'codex-refresh',
        id_token: codexIdToken('default-pool-user'),
        expires_in: 3600
      })
    }),
    startLoopbackCallbackServerImpl: (options) => {
      setImmediate(() => options.onListening({ url: options.redirectUri }));
      return { close() {} };
    },
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => ['8'],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('codex', 'oauth-browser');
  const running = manager.getJob(started.jobId);
  const completed = await manager.completeBrowserOauthCallback(
    started.jobId,
    `${running.redirectUri}?code=ok&state=${running.oauthState}`
  );
  assert.equal(completed.ok, true);
  const job = manager.getJob(started.jobId);
  assert.equal(job.status, 'succeeded');
  assert.equal(readAliasPoolConfig(fs, root, job.accountRef), null, '默认参与不落库');
});
