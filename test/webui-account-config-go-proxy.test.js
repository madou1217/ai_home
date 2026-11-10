'use strict';

// GET /v0/webui/accounts/:provider/:ref/config-files 固定读 Go：
// 账号校验、候选文件、脱敏与 SQLite 导出都在 Go 侧完成。这里锁住代理契约。

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleWebUiAccountConfigViewRoutes } = require('../lib/server/webui-account-config-view-routes');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';

async function call(options = {}) {
  let response;
  const headers = {};
  const deps = options.goResponse === undefined ? {} : {
    goCoreSync: {
      getAccountConfigFiles: async (provider, accountRef, mode) => {
        response = { provider, accountRef, mode };
        return options.goResponse;
      }
    }
  };
  let captured;
  const ctx = {
    method: options.method || 'GET',
    pathname: options.pathname || '/v0/webui/accounts/codex/' + ACCOUNT_REF + '/config-files',
    url: new URL('http://127.0.0.1' + (options.pathname || '/v0/webui/accounts/codex/' + ACCOUNT_REF + '/config-files') + (options.query || '')),
    res: { setHeader: (name, value) => { headers[name] = value; } },
    deps,
    writeJson: (_res, status, payload) => { captured = { status, payload }; }
  };
  const handled = await handleWebUiAccountConfigViewRoutes(ctx);
  return { handled, captured, headers, called: response };
}

test('账号配置：Go 返回文件列表时原样透传，并透传 mode', async () => {
  const data = { ok: true, provider: 'codex', accountRef: ACCOUNT_REF, mode: 'raw', runtimeDirExists: true, files: [] };
  const result = await call({ goResponse: { ok: true, status: 200, data }, query: '?mode=raw' });
  assert.equal(result.handled, true);
  assert.equal(result.captured.status, 200);
  assert.deepEqual(result.captured.payload, data);
  assert.equal(result.called.mode, 'raw');
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
});

test('账号配置：Go 的 404 透传', async () => {
  const data = { ok: false, error: 'account_not_found' };
  const result = await call({ goResponse: { ok: false, status: 404, data } });
  assert.equal(result.captured.status, 404);
  assert.deepEqual(result.captured.payload, data);
});

test('账号配置：缺少 Go 宿主时 503', async () => {
  const result = await call();
  assert.equal(result.captured.status, 503);
  assert.equal(result.captured.payload.error, 'go_core_unavailable');
});

test('账号配置：非 GET 405，其它路径不处理', async () => {
  const post = await call({ method: 'POST' });
  assert.equal(post.captured.status, 405);
  const other = await call({ pathname: '/v0/webui/accounts/codex/' + ACCOUNT_REF + '/status' });
  assert.equal(other.handled, false);
});
