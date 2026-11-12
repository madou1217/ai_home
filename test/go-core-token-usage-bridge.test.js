'use strict';

// 账号 token 用量接线：宿主方法的请求形状（ref 翻译 + tz_offset_minutes）与
// 调试对拍入口的 source 门禁。
//
// 只测接线，不测账本算法：数值口径由 Go 侧的 accountsapi 与 Node 的
// lib/usage/account-token-usage.js 各自负责，这里关心的是「参数有没有真的传下去」。
// 传丢 tz_offset_minutes 的后果很隐蔽：UTC 与本地日历只差几个小时，一天内的账号
// 数字看起来仍然「差不多」，只有跨天的窗口会整段错位，且对拍脚本会把它报成数据差异。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createGoCoreHost } = require('../lib/server/go-core-host');
const { handleWebUiAccountTokenUsageRoutes } = require('../lib/server/webui-account-token-usage-routes');
const { openAppStateDatabase } = require('../lib/server/app-state-store');
const { ensureAccountRefsTable } = require('../lib/server/account-ref-store');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';
const PROVIDER = 'codex';

function createHostWithStubClient(sendImpl) {
  const calls = [];
  const host = createGoCoreHost({
    // enabled:false 让宿主不启动子进程、不建账号同步、不挂定时器；这里只装配转发面。
    settings: { enabled: false, accountSync: false, routes: [] },
    manifest: { entries: [] },
    log: { log() {}, error() {} },
    createGoCoreSupervisor: () => ({
      status: () => ({ state: 'ready', endpoint: 'http://go.local:19550' }),
      start: async () => ({ state: 'ready', endpoint: 'http://go.local:19550' }),
      stop: async () => {}
    }),
    createGoCoreGatewayForwarder: () => ({
      tryHandleHttp: () => false,
      tryHandleUpgrade: () => false
    }),
    createGoManagementClient: () => ({
      send: async (request) => {
        calls.push(request);
        return sendImpl(request);
      }
    })
  });
  return { host, calls };
}

test('getAccountTokenUsage 把 Node ref 翻译后带上 tz_offset_minutes 请求 Go', async () => {
  const { host, calls } = createHostWithStubClient(() => ({
    ok: true,
    status: 200,
    data: { day: 1, week: 2, month: 3, total: 4, models: [], cost_known: false }
  }));

  const response = await host.getAccountTokenUsage(ACCOUNT_REF, { tzOffsetMinutes: -480 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  const url = new URL('http://go.local' + calls[0].path);
  assert.equal(url.pathname, '/v1/management/accounts/' + ACCOUNT_REF + '/token-usage');
  assert.equal(url.searchParams.get('tz_offset_minutes'), '-480');
  // 宿主只做转发：data 原样返回，不在这一层改形状（适配属于调用方）。
  assert.deepEqual(response, {
    ok: true,
    status: 200,
    data: { day: 1, week: 2, month: 3, total: 4, models: [], cost_known: false }
  });
});

test('getAccountTokenUsage 未指定偏移时按本地时区补，且 0 不被当成缺失', async () => {
  const { host, calls } = createHostWithStubClient(() => ({ ok: true, status: 200, data: {} }));

  await host.getAccountTokenUsage(ACCOUNT_REF);
  await host.getAccountTokenUsage(ACCOUNT_REF, { tzOffsetMinutes: 0 });

  const expectedDefault = String(new Date().getTimezoneOffset() * -1);
  const first = new URL('http://go.local' + calls[0].path);
  const second = new URL('http://go.local' + calls[1].path);
  assert.equal(first.searchParams.get('tz_offset_minutes'), expectedDefault);
  assert.equal(second.searchParams.get('tz_offset_minutes'), '0');
});

test('getAccountTokenUsage 在 Go 不可用时返回错误码而不是抛错', async () => {
  const host = createGoCoreHost({
    settings: { enabled: false, accountSync: false, routes: [] },
    manifest: { entries: [] },
    log: { log() {}, error() {} },
    createGoCoreSupervisor: () => ({
      status: () => ({ state: 'stopped', endpoint: '' }),
      start: async () => ({ state: 'stopped', endpoint: '' }),
      stop: async () => {}
    }),
    createGoCoreGatewayForwarder: () => ({
      tryHandleHttp: () => false,
      tryHandleUpgrade: () => false
    })
  });

  const response = await host.getAccountTokenUsage(ACCOUNT_REF);
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, 'go_core_unavailable');
});

function createCtx({ method = 'GET', pathname = '', query = '', dir = '', deps = {} } = {}) {
  const writes = [];
  const headers = {};
  const url = new URL('http://127.0.0.1' + (pathname || '/') + query);
  return {
    method,
    pathname: pathname || url.pathname,
    url,
    req: { url: url.pathname + url.search },
    res: { setHeader: (name, value) => { headers[name] = value; } },
    fs,
    aiHomeDir: dir,
    deps,
    writes,
    headers,
    writeJson: (_res, status, payload) => writes.push({ status, payload })
  };
}

const TOKEN_USAGE_PATH = '/v0/webui/accounts/' + PROVIDER + '/' + ACCOUNT_REF + '/token-usage';

function seedAccount(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-token-usage-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openAppStateDatabase(fs, dir, { createIfMissing: true });
  ensureAccountRefsTable(db);
  db.prepare('INSERT INTO account_refs (account_ref, provider, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(ACCOUNT_REF, PROVIDER, 1, 1);
  db.close();
  return dir;
}

test('调试路由不匹配其它路径时返回 false，不消费请求', async () => {
  const ctx = createCtx({ pathname: TOKEN_USAGE_PATH + '/extra' });
  assert.equal(await handleWebUiAccountTokenUsageRoutes(ctx), false);
  assert.equal(ctx.writes.length, 0);
});

test('调试路由不带 source 时 400（它不是正式契约）', async () => {
  const ctx = createCtx({ pathname: TOKEN_USAGE_PATH });
  assert.equal(await handleWebUiAccountTokenUsageRoutes(ctx), true);
  assert.equal(ctx.writes[0].status, 400);
  assert.equal(ctx.writes[0].payload.error, 'source_required');
  assert.equal(ctx.headers['cache-control'], 'no-store');
});

test('调试路由只认 source=go，其它取值同样 400', async () => {
  const ctx = createCtx({ pathname: TOKEN_USAGE_PATH, query: '?source=node' });
  await handleWebUiAccountTokenUsageRoutes(ctx);
  assert.equal(ctx.writes[0].status, 400);
  assert.equal(ctx.writes[0].payload.error, 'source_required');
});

test('source=go 时返回 Go 原始结果，且不回落本地', async (t) => {
  const dir = seedAccount(t);
  const calls = [];
  const ctx = createCtx({
    pathname: TOKEN_USAGE_PATH,
    query: '?source=go',
    dir,
    deps: {
      goCoreSync: {
        getAccountTokenUsage: async (accountRef) => {
          calls.push(accountRef);
          return { ok: true, status: 200, data: { day: 11, week: 22, month: 33, total: 44, models: [], cost_known: false } };
        }
      }
    }
  });

  assert.equal(await handleWebUiAccountTokenUsageRoutes(ctx), true);
  assert.deepEqual(calls, [ACCOUNT_REF]);
  assert.equal(ctx.writes[0].status, 200);
  assert.deepEqual(ctx.writes[0].payload, {
    ok: true,
    go: { day: 11, week: 22, month: 33, total: 44, models: [], cost_known: false }
  });
});

test('Go 失败时把状态码透出，不返回 Node 自己的数', async (t) => {
  const dir = seedAccount(t);
  const ctx = createCtx({
    pathname: TOKEN_USAGE_PATH,
    query: '?source=go',
    dir,
    deps: {
      goCoreSync: {
        getAccountTokenUsage: async () => ({ ok: false, status: 503, errorCode: 'token_usage_unavailable' })
      }
    }
  });

  await handleWebUiAccountTokenUsageRoutes(ctx);
  assert.equal(ctx.writes[0].status, 503);
  assert.equal(ctx.writes[0].payload.error, 'token_usage_unavailable');
});
