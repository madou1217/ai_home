'use strict';

// Go 刷新入口的错误分类回归（2026-11-12）。
//
// Go 的业务错误体（writeError）是 {ok:false, error:"account_not_found", message}；
// 管理客户端把它归成 http_404/401。http_404 又在「Go 没这条路由」的回退名单里，
// 于是 Go 明确回答的账号不存在被当成路由缺失回退；goOnly 账号无法本地回退，
// 最终只剩一句「Go Core 不可用」。401 的对象形状错误体还会被 String() 成
// "[object Object]"。这里用 goOnly 账号做显影剂：分类错了断言必然红。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { handleRefreshAccountRequest } = require('../lib/server/webui-account-refresh');
const { accountRefreshJobs } = require('../lib/server/webui-account-routes-refresh');

const PROVIDER = 'agy';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-account-refresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 最小 Go 账号库：goOnlyAccountExists 会整份读 accounts + 关联表，
// 缺任何一张表都会让 readGoAccounts 抛错，账号被当成不存在。
function writeGoAccount(dir, accountRef) {
  const db = new DatabaseSync(path.join(dir, 'aih.db'));
  db.exec(`
    CREATE TABLE accounts (
      account_ref TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      cli_account_id INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE account_credentials (
      account_ref TEXT PRIMARY KEY,
      auth_kind TEXT,
      auth_mode TEXT,
      credential_json TEXT,
      updated_at_ms INTEGER
    );
    CREATE TABLE account_profiles (
      account_ref TEXT PRIMARY KEY,
      profile_json TEXT,
      email TEXT,
      subscription_raw TEXT
    );
    CREATE TABLE account_defaults (provider_id TEXT, account_ref TEXT);
    CREATE TABLE account_models (account_ref TEXT, model_id TEXT, manual_policy TEXT);
  `);
  db.prepare('INSERT INTO accounts (account_ref, provider_id, cli_account_id, enabled) VALUES (?, ?, 1, 1)')
    .run(accountRef, PROVIDER);
  db.close();
}

function createCtx(dir, host, accountRef) {
  const writes = [];
  return {
    pathname: `/v0/webui/accounts/${PROVIDER}/${accountRef}/refresh`,
    res: {},
    fs,
    deps: { aiHomeDir: dir, goCoreSync: host },
    state: {},
    accountStateIndex: { getAccountState: () => null },
    writes,
    writeJson: (_res, status, payload) => writes.push({ status, payload })
  };
}

async function waitForTerminal(jobId, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = accountRefreshJobs.get(jobId);
    if (job && (job.status === 'succeeded' || job.status === 'failed')) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('刷新作业未在限定时间内收尾');
}

async function runGoOnlyRefresh(t, accountRef, goResult) {
  const dir = tmpDir(t);
  writeGoAccount(dir, accountRef);
  const host = {
    refreshAccountWebUI: async () => goResult,
    // 明确失败应在 POST 回包后直接收尾，不该再轮询作业。
    getRefreshJob: async () => { throw new Error('不应轮询已明确失败的作业'); }
  };
  const ctx = createCtx(dir, host, accountRef);
  handleRefreshAccountRequest(ctx);
  assert.equal(ctx.writes.length, 1);
  assert.equal(ctx.writes[0].status, 202);
  return waitForTerminal(ctx.writes[0].payload.job.id);
}

test('Go 404 account_not_found 原样透出，不被回退成 Go Core 不可用', async (t) => {
  const job = await runGoOnlyRefresh(t, 'acct_00000000000000000001', {
    ok: false,
    status: 404,
    data: { ok: false, error: 'account_not_found', message: '账号不存在' },
    errorCode: 'http_404'
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'account_not_found');
  assert.deepEqual(job.failedBranches, ['status', 'models', 'usage']);
});

test('Go 401 unauthorized（字符串错误体）原样透出', async (t) => {
  const job = await runGoOnlyRefresh(t, 'acct_00000000000000000002', {
    ok: false,
    status: 401,
    data: { ok: false, error: 'unauthorized', message: '需要管理密钥' },
    errorCode: 'http_401'
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'unauthorized');
});

test('Go 401 unauthorized（对象错误体）取 code，不落成 [object Object]', async (t) => {
  const job = await runGoOnlyRefresh(t, 'acct_00000000000000000003', {
    ok: false,
    status: 401,
    data: { ok: false, error: { code: 'unauthorized', message: '需要管理密钥' } },
    errorCode: 'unauthorized'
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'unauthorized');
});

test('真正的 Go Core 不可用仍然保留原失败文案', async (t) => {
  const job = await runGoOnlyRefresh(t, 'acct_00000000000000000004', {
    ok: false,
    status: 0,
    data: null,
    errorCode: 'go_core_unavailable'
  });
  assert.equal(job.status, 'failed');
  assert.equal(job.error, 'Go Core 不可用，无法刷新该账号');
});
