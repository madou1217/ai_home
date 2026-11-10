'use strict';

// GET /v0/webui/accounts/:provider/:ref/model-context 固定读 Go：
// 覆盖 > 探测快照 > models.dev 目录的解析都在 Go 侧完成。这里锁住代理契约。

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleModelContextRequest } = require('../lib/server/webui-model-context-routes');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';

async function call(options = {}) {
  let captured;
  let forwarded;
  const deps = options.goResponse === undefined ? {} : {
    goCoreSync: {
      getAccountModelContext: async (provider, accountRef, models) => {
        forwarded = { provider, accountRef, models };
        return options.goResponse;
      }
    }
  };
  const pathname = options.pathname || '/v0/webui/accounts/codex/' + ACCOUNT_REF + '/model-context';
  const ctx = {
    method: 'GET',
    pathname,
    url: new URL('http://127.0.0.1' + pathname + (options.query || '')),
    res: {},
    deps,
    fs: {},
    aiHomeDir: '/tmp/ai-home',
    writeJson: (_res, status, payload) => { captured = { status, payload }; }
  };
  const handled = await handleModelContextRequest(ctx);
  return { handled, captured, forwarded };
}

test('模型上下文：Go 返回结果时原样透传，并转发 models 查询', async () => {
  const data = {
    ok: true,
    accountRef: ACCOUNT_REF,
    provider: 'codex',
    models: [{ model: 'gpt-5', tokens: 128000, source: 'catalog', override: 0 }],
    limits: { min: 1024, max: 2000000 },
    sameTypeAccounts: [],
    credentialType: 'oauth'
  };
  const result = await call({ goResponse: { ok: true, status: 200, data }, query: '?models=gpt-5' });
  assert.equal(result.handled, true);
  assert.equal(result.captured.status, 200);
  assert.deepEqual(result.captured.payload, data);
  assert.deepEqual(result.forwarded, { provider: 'codex', accountRef: ACCOUNT_REF, models: 'gpt-5' });
});

test('模型上下文：Go 的 404 透传', async () => {
  const data = { ok: false, error: 'account_not_found' };
  const result = await call({ goResponse: { ok: false, status: 404, data } });
  assert.equal(result.captured.status, 404);
  assert.deepEqual(result.captured.payload, data);
});

test('模型上下文：缺少 Go 宿主时 503', async () => {
  const result = await call();
  assert.equal(result.captured.status, 503);
  assert.equal(result.captured.payload.error, 'go_core_unavailable');
});

test('模型上下文：其它路径不处理', async () => {
  const result = await call({ pathname: '/v0/webui/accounts/codex/' + ACCOUNT_REF + '/status' });
  assert.equal(result.handled, false);
});
