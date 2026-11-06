'use strict';

// 账号级路由排除：Node 判定为「自定义上游」的账号推给 Go，Go 不再把它放进路由候选
// 与模型目录；其余账号照常由 Go 服务。
//
// 为什么单独测这一层：这条推送的失效方式全是静默的——漏推 = 自定义上游账号又被 Go
// 选中（远端额度写成本地状态），多推 = 每轮对账几十个请求，误推 = 官方账号流量全回
// Node。只有当「判定 / 签名 / 重试」三件事都被断言住，才能保证它不退化。

const test = require('node:test');
const assert = require('node:assert/strict');

const { pushAccountRoutingExclusions } = require('../lib/server/go-account-sync');

function createClient(responses = []) {
  const calls = [];
  return {
    calls,
    send: async (request) => {
      calls.push(request);
      const next = responses.shift();
      return next || { ok: true };
    }
  };
}

function createResult() {
  return { routingExclusionsPushed: 0, errors: [] };
}

// 自定义上游账号：API 密钥模式 + 指向自建网关的 base URL（判定口径见
// lib/account/official-upstream-endpoint.js）。
function customAccount(overrides = {}) {
  return {
    provider: 'codex',
    accountRef: 'acct_node1',
    env: { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'http://54.178.88.80:9527/v1' },
    state: { apiKeyMode: true },
    ...overrides
  };
}

test('自定义上游账号被排除一次', async () => {
  const client = createClient();
  const result = createResult();
  const signatures = new Map();
  await pushAccountRoutingExclusions({
    client,
    primaryByGoRef: new Map([['acct_go1', customAccount()]]),
    pushedSignatures: signatures,
    result
  });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, 'PUT');
  assert.equal(client.calls[0].path, '/v1/management/accounts/acct_go1/routing');
  assert.deepEqual(client.calls[0].body, { excluded: true, reason: 'custom_upstream' });
  assert.equal(result.routingExclusionsPushed, 1);
  assert.equal(signatures.get('acct_go1'), 'excluded:custom_upstream');
});

test('官方端点账号一个请求都不发', async () => {
  const client = createClient();
  const result = createResult();
  await pushAccountRoutingExclusions({
    client,
    primaryByGoRef: new Map([
      // 显式官方地址
      ['acct_go_official', customAccount({ env: { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://api.openai.com/v1' } })],
      // 没配地址 = 走厂商默认端点
      ['acct_go_default', customAccount({ env: { OPENAI_API_KEY: 'sk-test' } })],
      // OAuth 登录态：即使留着自定义地址也不是「自定义上游账号」（唯一口径如此）
      ['acct_go_oauth', customAccount({ state: { apiKeyMode: false } })]
    ]),
    pushedSignatures: new Map(),
    result
  });
  assert.equal(client.calls.length, 0);
  assert.equal(result.routingExclusionsPushed, 0);
  assert.equal(result.errors.length, 0);
});

test('同一份状态不重复推送', async () => {
  const client = createClient();
  const result = createResult();
  const signatures = new Map();
  const options = {
    client,
    primaryByGoRef: new Map([['acct_go1', customAccount()]]),
    pushedSignatures: signatures,
    result
  };
  await pushAccountRoutingExclusions(options);
  await pushAccountRoutingExclusions(options);
  assert.equal(client.calls.length, 1, '第二轮应被判重');
  assert.equal(result.routingExclusionsPushed, 1);

  // 值变了（换成另一个自定义上游主机）也还是排除，但不再是「新值」——签名不变即不推。
  options.primaryByGoRef = new Map([
    ['acct_go1', customAccount({ env: { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://one-api.example.com/v1' } })]
  ]);
  await pushAccountRoutingExclusions(options);
  assert.equal(client.calls.length, 1, '排除状态没变就不必重推');
});

test('地址改回官方端点时推送放行', async () => {
  const client = createClient();
  const result = createResult();
  const signatures = new Map([['acct_go1', 'excluded:custom_upstream']]);
  await pushAccountRoutingExclusions({
    client,
    primaryByGoRef: new Map([
      ['acct_go1', customAccount({ env: { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://api.openai.com/v1' } })]
    ]),
    pushedSignatures: signatures,
    result
  });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].body, { excluded: false, reason: '' });
  assert.equal(signatures.get('acct_go1'), 'included');
});

test('推送失败记 routing_exclusion 且不写签名，下一轮重试', async () => {
  const client = createClient([{ ok: false, errorCode: 'account_not_found' }]);
  const result = createResult();
  const signatures = new Map();
  const options = {
    client,
    primaryByGoRef: new Map([['acct_go1', customAccount()]]),
    pushedSignatures: signatures,
    result
  };
  await pushAccountRoutingExclusions(options);
  assert.equal(result.routingExclusionsPushed, 0);
  assert.deepEqual(result.errors, [
    { account_ref: 'acct_go1', step: 'routing_exclusion', error: 'account_not_found' }
  ]);
  assert.equal(signatures.has('acct_go1'), false, '失败不应写签名，否则下一轮不再重试');

  await pushAccountRoutingExclusions(options);
  assert.equal(client.calls.length, 2, '下一轮必须重试');
  assert.equal(result.routingExclusionsPushed, 1);
  assert.equal(signatures.get('acct_go1'), 'excluded:custom_upstream');
});

test('Go 里新建的账号行即使签名相同也要重推', async () => {
  const client = createClient();
  const result = createResult();
  // 删除后同密钥同 URL 重新导入会拿到同一个 goRef，旧签名记录的是已被删掉的那一行。
  const signatures = new Map([['acct_go1', 'excluded:custom_upstream']]);
  await pushAccountRoutingExclusions({
    client,
    primaryByGoRef: new Map([['acct_go1', customAccount()]]),
    pushedSignatures: signatures,
    createdRefs: new Set(['acct_go1']),
    result
  });
  assert.equal(client.calls.length, 1, '新行没有排除标记，必须重推');
  assert.equal(result.routingExclusionsPushed, 1);
});

test('缺少客户端或账号表时直接跳过', async () => {
  const result = createResult();
  await pushAccountRoutingExclusions({ client: null, primaryByGoRef: new Map(), result });
  await pushAccountRoutingExclusions({ client: createClient(), primaryByGoRef: null, result });
  assert.equal(result.routingExclusionsPushed, 0);
  assert.equal(result.errors.length, 0);
});
