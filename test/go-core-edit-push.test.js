'use strict';

// 「编辑即推送」的接线守卫：WebUI 里改账号/规则/别名后必须立刻重推 Go 投影。
//
// 只断言接线本身（谁触发、推哪一份、缺装配时是否安全），投影内容与 Go 侧接受语义
// 分别由 upstream-error-rules-projection / go-core-host 的测试覆盖。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handleWebUiModelAliasRoutes } = require('../lib/server/webui-model-alias-routes');
const { handleWebUiUpstreamErrorMappingRoutes } = require('../lib/server/webui-upstream-error-mapping-routes');
const { reloadRuntimeAccountsIfNeeded } = require('../lib/server/webui-account-routes-utils');
const { createServerPoolSyncListener } = require('../lib/server/account-runtime-event-listeners');
const { handleManagementRequest } = require('../lib/server/management-router');
const { saveAliases } = require('../lib/server/model-alias-store');

/** 记录推送调用的 goCoreSync 替身；flush 等待 fire-and-forget 的推送链跑完。 */
function createSyncSpy() {
  const calls = [];
  return {
    calls,
    host: {
      pushModelAliases: async () => { calls.push('modelAliases'); },
      pushUpstreamErrorRules: async () => { calls.push('upstreamErrorRules'); }
    }
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function tempHome(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function responseCapture() {
  return {
    statusCode: 0,
    body: '',
    writeHead(statusCode) { this.statusCode = statusCode; },
    end(body = '') { this.body = String(body); }
  };
}

test('model alias edits push the alias projection to Go immediately', async (t) => {
  const aiHomeDir = tempHome(t, 'aih-alias-edit-push-');
  await saveAliases(fs, aiHomeDir, {
    aliases: [{
      id: 'alias-1', alias: 'claude-haiku-*', target: 'gpt-5.5',
      provider: 'all', targetProvider: 'auto', enabled: true
    }]
  });
  const spy = createSyncSpy();
  const state = { accounts: {}, modelAccountIndex: null, webUiModelsCache: {} };
  const call = async (method, pathname) => {
    const res = responseCapture();
    const handled = await handleWebUiModelAliasRoutes({
      method,
      pathname,
      req: {},
      res,
      state,
      deps: {
        fs,
        aiHomeDir,
        goCoreSync: spy.host,
        readRequestBody: async () => Buffer.from('{}'),
        writeJson: (_res, statusCode, body) => {
          res.statusCode = statusCode;
          res.end(JSON.stringify(body));
        }
      }
    });
    return { handled, statusCode: res.statusCode };
  };

  assert.equal((await call('POST', '/v0/webui/model-aliases/alias-1/toggle')).statusCode, 200);
  await flush();
  assert.deepEqual(spy.calls, ['modelAliases']);

  assert.equal((await call('DELETE', '/v0/webui/model-aliases/alias-1')).statusCode, 200);
  await flush();
  assert.deepEqual(spy.calls, ['modelAliases', 'modelAliases']);

  // 只读请求不推送。
  assert.equal((await call('GET', '/v0/webui/model-aliases')).statusCode, 200);
  await flush();
  assert.deepEqual(spy.calls, ['modelAliases', 'modelAliases']);
});

test('mapping group edits push the rules projection to Go immediately', async (t) => {
  const aiHomeDir = tempHome(t, 'aih-mapping-edit-push-');
  const spy = createSyncSpy();
  const state = { accounts: {}, modelAccountIndex: null, webUiModelsCache: {} };
  const call = async (method, pathname, payload) => {
    const res = responseCapture();
    const handled = await handleWebUiUpstreamErrorMappingRoutes({
      method,
      pathname,
      req: {},
      res,
      fs,
      aiHomeDir,
      state,
      loadServerRuntimeAccounts: () => ({ codex: [] }),
      applyReloadState: () => {},
      readRequestBody: async () => Buffer.from(payload === undefined ? '' : JSON.stringify(payload)),
      writeJson: (_res, statusCode, body) => {
        res.statusCode = statusCode;
        res.end(JSON.stringify(body));
      },
      deps: { aiHomeDir, goCoreSync: spy.host }
    });
    return { handled, statusCode: res.statusCode, body: JSON.parse(res.body || '{}') };
  };

  const created = await call('POST', '/v0/webui/upstream-error-mappings', {
    name: 'New API 余额不足',
    provider: 'codex',
    enabled: true,
    rules: [{
      name: '余额不足', enabled: true, statuses: [403], kind: 'billing_blocked',
      matchers: [{ source: 'json', path: 'error.code', operator: 'equals', value: 'insufficient_user_quota' }]
    }]
  });
  assert.equal(created.statusCode, 200);
  await flush();
  assert.deepEqual(spy.calls, ['upstreamErrorRules']);

  assert.equal((await call('POST', `/v0/webui/upstream-error-mappings/${created.body.group.id}/toggle`)).statusCode, 200);
  await flush();
  assert.deepEqual(spy.calls, ['upstreamErrorRules', 'upstreamErrorRules']);
});

test('an account pool reload pushes the rules projection and survives a missing Go sync entry', async () => {
  const spy = createSyncSpy();
  const state = { accounts: {} };
  const ctx = {
    state,
    fs,
    accountStateIndex: {},
    deps: { aiHomeDir: '/tmp/aih-none', goCoreSync: spy.host },
    getProfileDir: () => '',
    checkStatus: () => ({}),
    loadServerRuntimeAccounts: () => ({ codex: [{ accountRef: 'acct_1' }] }),
    applyReloadState: (target, accounts) => { target.accounts = accounts; }
  };
  assert.equal(reloadRuntimeAccountsIfNeeded(ctx), true);
  await flush();
  assert.deepEqual(spy.calls, ['upstreamErrorRules']);
  assert.deepEqual(state.accounts, { codex: [{ accountRef: 'acct_1' }] });

  // 旧宿主 / 测试替身没有注入 goCoreSync：编辑照常成功，只是不推送。
  const withoutSync = { ...ctx, deps: { aiHomeDir: '/tmp/aih-none' } };
  assert.equal(reloadRuntimeAccountsIfNeeded(withoutSync), true);
  await flush();
  assert.deepEqual(spy.calls, ['upstreamErrorRules']);
});

test('runtime-event pool reloads push the rules projection', async () => {
  const spy = createSyncSpy();
  const state = { accounts: {} };
  const listener = createServerPoolSyncListener({
    state,
    // 宿主装配期 goCoreSync 还是 null，用 getter 读装配后的实例（与 server.js 同形）。
    get goCoreSync() { return spy.host; },
    loadServerRuntimeAccounts: () => ({ codex: [{ accountRef: 'acct_1' }] }),
    applyReloadState: (target, accounts) => { target.accounts = accounts; }
  });
  assert.equal(listener({ provider: 'codex', accountRef: 'acct_1', runtimeState: null }), true);
  await flush();
  assert.deepEqual(spy.calls, ['upstreamErrorRules']);
});

test('the management reload endpoint pushes the rules projection', async () => {
  const spy = createSyncSpy();
  const state = { accounts: { codex: [], gemini: [], claude: [] } };
  const res = responseCapture();
  const handled = await handleManagementRequest({
    method: 'POST',
    pathname: '/v0/management/reload',
    url: new URL('http://localhost/v0/management/reload'),
    req: { headers: {} },
    res,
    options: {},
    state,
    requiredManagementKey: '',
    deps: {
      parseAuthorizationBearer: () => '',
      writeJson: (_res, statusCode, body) => {
        res.statusCode = statusCode;
        res.end(JSON.stringify(body));
      },
      loadServerRuntimeAccounts: () => ({ codex: [{ accountRef: 'acct_1' }], gemini: [], claude: [] }),
      applyReloadState: (target, runtime) => {
        target.accounts.codex = runtime.codex.slice();
        target.accounts.gemini = runtime.gemini.slice();
        target.accounts.claude = runtime.claude.slice();
      },
      fs: {},
      getProfileDir: () => '',
      checkStatus: () => ({ configured: true }),
      goCoreSync: spy.host
    }
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  await flush();
  assert.deepEqual(spy.calls, ['upstreamErrorRules']);
});

// 池变即推送是「编辑即推送」的另一半：任何重载运行池的地方都可能改变规则投影，
// 漏一处就等于那段时间里 go-core-route-deferral 按旧规则表决定请求交给谁。
// 新加重载点必须同时加推送（或显式更新这份清单说明为何不需要）。
test('every runtime-pool mutation site pushes the rules projection', () => {
  const serverDir = path.join(__dirname, '..', 'lib', 'server');
  const callSitePattern = /(^|[^.\w])(applyReloadState|applyRuntimeReloadState)\(/;
  const definitionPattern = /function\s+(applyReloadState|applyRuntimeReloadState)\s*\(/;
  const mutationSites = [];
  for (const name of fs.readdirSync(serverDir).filter((entry) => entry.endsWith('.js')).sort()) {
    const text = fs.readFileSync(path.join(serverDir, name), 'utf8');
    const isMutationSite = text.split('\n').some((line) => (
      callSitePattern.test(line) && !definitionPattern.test(line)
    ));
    if (!isMutationSite) continue;
    mutationSites.push(name);
    assert.match(
      text,
      /notifyGoCoreProjection\(/,
      `${name} 重载了运行池但没有推送规则投影（见 go-core-projection-sync）`
    );
  }
  assert.deepEqual(mutationSites, [
    'account-runtime-event-listeners.js',
    'management-router.js',
    'server.js',
    'web-ui-router.js',
    'webui-account-live.js',
    'webui-account-routes-utils.js',
    'webui-openai-model-routes.js'
  ]);
});
