'use strict';

// 回归:Node 只在服务启动时探测一次 codex 版本,CLI 自动升级后仍按旧 client_version 拉
// 模型目录,上游不下发新模型(如 gpt-6.1-sol 需要 >= 0.159.0),要重启服务才看得到。

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchCodexModelCatalogForAccount, resolveCodexClientVersion } = require('../lib/server/codex-model-client');

test('模型目录按当前探测到的 codex 版本请求,而不是启动时记下的旧值', async () => {
  let current = '0.158.0';
  const options = {
    codexBaseUrl: 'https://upstream.example.com/backend-api/codex',
    codexClientVersion: '0.158.0',
    currentCodexClientVersion: () => current
  };
  const urls = [];
  const fetchWithTimeout = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ctx = { options, account: { accessToken: 'token' }, fetchWithTimeout, timeoutMs: 1000 };

  await fetchCodexModelCatalogForAccount(ctx);
  current = '0.159.2';
  await fetchCodexModelCatalogForAccount(ctx);

  assert.match(urls[0], /client_version=0\.158\.0/);
  assert.match(urls[1], /client_version=0\.159\.2/);
});

test('人工锁定版本(没有自动探测源)时使用配置值', () => {
  assert.equal(resolveCodexClientVersion({ codexClientVersion: '0.150.0' }), '0.150.0');
});
