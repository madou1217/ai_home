'use strict';

// 探针推送的**传输层**验收：用真实的管理客户端（lib/account/go-bridge/go-management-client）
// 打一个本地 HTTP 服务，确认 pushAccountProbes 发出的方法/路径/头/体与失败处理都成立。
//
// 为什么不用假 client：pushAccountProbes 的单元测试（go-account-sync-probe.test.js）把
// client 换成了对象，只能证明「它想让 client 做什么」。这里换成真客户端，才能证明
// 请求真的能被 Go 的 /v1/management/accounts/{ref}/probe 接住——包括 ref 的 URL 编码、
// Management Key 的位置、以及 Go 的 {error:{code}} 错误形状能被翻译成 errorCode。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createGoManagementClient } = require('../lib/account/go-bridge/go-management-client');
const { pushAccountProbes } = require('../lib/server/go-account-sync');

function startServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const entry = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: raw ? JSON.parse(raw) : null
      };
      requests.push(entry);
      const reply = handler(entry);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        requests,
        baseUrl: 'http://127.0.0.1:' + port,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

test('真实客户端把探针结果 PATCH 到 Go 的探针端点', async () => {
  const fake = await startServer(() => ({ status: 200, body: { ok: true } }));
  try {
    const client = createGoManagementClient({ baseUrl: fake.baseUrl, managementKey: 'mgmt_test_key' });
    const result = { probePushed: 0, errors: [] };
    const signatures = new Map();
    await pushAccountProbes({
      client,
      // ref 里带需要编码的字符，验证 path 拼接没有把 ref 直接塞进 URL。
      primaryByGoRef: new Map([['acct go/1', { provider: 'codex', accountRef: 'acct_node1' }]]),
      probeState: () => ({ checkedAt: 1730000000000, error: '' }),
      pushedSignatures: signatures,
      result
    });

    assert.equal(fake.requests.length, 1);
    const [request] = fake.requests;
    assert.equal(request.method, 'PATCH');
    assert.equal(request.url, '/v1/management/accounts/acct%20go%2F1/probe');
    assert.equal(request.authorization, 'Bearer mgmt_test_key');
    assert.equal(request.contentType, 'application/json');
    assert.deepEqual(request.body, {
      status: 'ok',
      error: '',
      checked_at_ms: 1730000000000
    });
    assert.equal(result.probePushed, 1);
    assert.equal(signatures.get('acct go/1'), '1730000000000:');
  } finally {
    await fake.close();
  }
});

test('Go 返回业务错误时记到 errors 且保留重试', async () => {
  const fake = await startServer(() => ({
    status: 404,
    body: { error: { code: 'account_not_found', message: '账号不存在' } }
  }));
  try {
    const client = createGoManagementClient({ baseUrl: fake.baseUrl, managementKey: 'mgmt_test_key' });
    const result = { probePushed: 0, errors: [] };
    const signatures = new Map();
    await pushAccountProbes({
      client,
      primaryByGoRef: new Map([['acct_missing', { provider: 'claude', accountRef: 'acct_node9' }]]),
      probeState: () => ({ checkedAt: 7, error: '401 invalid token' }),
      pushedSignatures: signatures,
      result
    });

    assert.equal(result.probePushed, 0);
    assert.deepEqual(result.errors, [
      { account_ref: 'acct_missing', step: 'probe', error: 'account_not_found' }
    ]);
    assert.equal(signatures.has('acct_missing'), false, '失败不写签名，下一轮还会重试');
    assert.equal(fake.requests[0].body.status, 'error');
  } finally {
    await fake.close();
  }
});
