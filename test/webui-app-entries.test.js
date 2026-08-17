'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  handleOpenAccountAppRequest,
  handleListAppEntriesRequest
} = require('../lib/server/webui-account-routes');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { writeAccountCredentials } = require('../lib/server/account-credential-store');

function createResCapture() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) {
      this.statusCode = code;
    },
    end(chunk = '') {
      this.body = String(chunk);
    },
    json() {
      return JSON.parse(this.body || '{}');
    }
  };
}

function writeJson(res, code, payload) {
  res.writeHead(code);
  res.end(JSON.stringify(payload));
}

function createFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-app-entries-'));
  t.after(() => {
    fs.rmSync(aiHomeDir, { recursive: true, force: true });
  });
  const accountRef = upsertAccountRef(fs, aiHomeDir, {
    provider: 'zcode',
    cliAccountId: '7',
    identitySeed: 'oauth:zcode:app-entries@example.com'
  });
  assert.match(accountRef, /^acct_[a-f0-9]{20}$/);
  writeAccountCredentials(fs, aiHomeDir, accountRef, { ZCODE_API_KEY: 'fixture-key' });
  return { aiHomeDir, accountRef };
}

function createOpenAppCtx(fixture, payload) {
  return {
    pathname: `/v0/webui/accounts/zcode/${fixture.accountRef}/open-app`,
    req: {},
    res: createResCapture(),
    fs,
    aiHomeDir: fixture.aiHomeDir,
    deps: { aiHomeDir: fixture.aiHomeDir },
    readRequestBody: async () => Buffer.from(JSON.stringify(payload)),
    getProfileDir: (provider, accountRef) => path.join(fixture.aiHomeDir, 'run', 'auth-projections', provider, accountRef),
    writeJson
  };
}

test('open-app 端点透传 close action，无运行实例时返回 not_running', async (t) => {
  const fixture = createFixture(t);
  const ctx = createOpenAppCtx(fixture, { kind: 'desktop', action: 'close' });
  const handled = await handleOpenAccountAppRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 200);
  const body = ctx.res.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, 'not_running');
  assert.deepEqual(body.pids, []);
});

test('open-app 端点对未知 action 返回 400 unsupported_action', async (t) => {
  const fixture = createFixture(t);
  const ctx = createOpenAppCtx(fixture, { kind: 'desktop', action: 'restart' });
  const handled = await handleOpenAccountAppRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 400);
  assert.equal(ctx.res.json().error, 'unsupported_action');
});

test('open-app 端点对 cli+close 返回 400 unsupported_action', async (t) => {
  const fixture = createFixture(t);
  const ctx = createOpenAppCtx(fixture, { kind: 'cli', action: 'close' });
  const handled = await handleOpenAccountAppRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 400);
  assert.equal(ctx.res.json().error, 'unsupported_action');
});

test('open-app 端点对缺失账号返回 404 account_not_found', async (t) => {
  const fixture = createFixture(t);
  const ctx = createOpenAppCtx(fixture, { kind: 'desktop', action: 'open' });
  ctx.pathname = '/v0/webui/accounts/zcode/acct_ffffffffffffffffffff/open-app';
  const handled = await handleOpenAccountAppRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 404);
  assert.equal(ctx.res.json().error, 'account_not_found');
});

test('app-entries 端点返回按 Provider 分组的布尔入口可用性并命中缓存', async (t) => {
  const fixture = createFixture(t);
  const ctx = {
    pathname: '/v0/webui/app-entries',
    req: {},
    res: createResCapture(),
    fs,
    aiHomeDir: fixture.aiHomeDir,
    deps: { aiHomeDir: fixture.aiHomeDir },
    writeJson
  };
  const handled = await handleListAppEntriesRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 200);
  const body = ctx.res.json();
  assert.equal(body.ok, true);
  assert.ok(body.entries && typeof body.entries === 'object');
  assert.ok(body.entries.zcode, 'zcode 必须在条目中');
  assert.equal(typeof body.entries.zcode.desktop, 'boolean');
  assert.equal(typeof body.entries.zcode.cli, 'boolean');
  // 未声明 desktopClient 的 Provider 恒为 desktop:false
  assert.equal(body.entries.kiro.desktop, false);
  assert.ok(Array.isArray(body.runningAccounts), '响应必须带 runningAccounts 数组');
});

// createAppEntriesCtx 构造可注入检测器的 app-entries 请求上下文。
function createAppEntriesCtx(fixture, appEntryDetector) {
  return {
    pathname: '/v0/webui/app-entries',
    req: {},
    res: createResCapture(),
    fs,
    aiHomeDir: fixture.aiHomeDir,
    deps: { aiHomeDir: fixture.aiHomeDir, appEntryDetector },
    getProfileDir: (provider, accountRef) => path.join(fixture.aiHomeDir, 'run', 'auth-projections', provider, accountRef),
    writeJson
  };
}

test('app-entries 端点把批量扫描命中的账号列入 runningAccounts', async (t) => {
  const fixture = createFixture(t);
  const userDataDir = path.join(
    fixture.aiHomeDir, 'run', 'auth-projections', 'zcode', fixture.accountRef, 'electron-user-data'
  );
  const ctx = createAppEntriesCtx(fixture, {
    detect: () => ({ zcode: { desktop: true, cli: false } }),
    scanRunning: () => [
      { pid: 9001, userDataDir },
      // 其它账号/应用的实例不应匹配
      { pid: 9002, userDataDir: path.join(fixture.aiHomeDir, 'run', 'auth-projections', 'zcode', 'acct_other') + path.sep + 'electron-user-data' }
    ]
  });
  const handled = await handleListAppEntriesRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 200);
  const body = ctx.res.json();
  assert.deepEqual(body.entries, { zcode: { desktop: true, cli: false } });
  assert.deepEqual(body.runningAccounts, [fixture.accountRef]);
});

test('app-entries 端点在扫描失败时降级为空 runningAccounts 且 entries 不受影响', async (t) => {
  const fixture = createFixture(t);
  const ctx = createAppEntriesCtx(fixture, {
    detect: () => ({ zcode: { desktop: true, cli: false } }),
    scanRunning: () => {
      throw new Error('scan failed');
    }
  });
  const handled = await handleListAppEntriesRequest(ctx);
  assert.equal(handled, true);
  assert.equal(ctx.res.statusCode, 200);
  const body = ctx.res.json();
  assert.deepEqual(body.entries, { zcode: { desktop: true, cli: false } });
  assert.deepEqual(body.runningAccounts, []);
});
