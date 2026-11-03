'use strict';

// 回归守卫：领取请求的**响应体**读取也要有上界。
//
// fetchWithTimeout 只在响应头回来前 abort；正文卡住时 response.text() 会一直等，
// 计划任务因此可能撞到 30 分钟 task_timeout。这里用永不 resolve 的正文证明会返回
// fetch_body_timeout，而不是挂住调用方。

const test = require('node:test');
const assert = require('node:assert');
const { fetchClaimJson } = require('../lib/account/activity-claim/http');

test('响应正文卡住时按 timeout 返回 fetch_body_timeout', async () => {
  const startedAt = Date.now();
  const result = await fetchClaimJson(
    async () => ({ status: 200, ok: true, text: () => new Promise(() => {}) }),
    'https://example.invalid/',
    { method: 'POST' },
    1100,
    {}
  );
  const elapsedMs = Date.now() - startedAt;
  assert.match(String(result.error), /^request_failed:fetch_body_timeout:1100$/, `实际 ${result.error}`);
  assert.ok(elapsedMs < 4000, `应在 deadline 附近返回，实际 ${elapsedMs}ms`);
});

test('正文正常时照常解析 JSON', async () => {
  const result = await fetchClaimJson(
    async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ code: 0, msg: 'ok' }) }),
    'https://example.invalid/',
    { method: 'POST' },
    1100,
    {}
  );
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.deepEqual(result.json, { code: 0, msg: 'ok' });
});

