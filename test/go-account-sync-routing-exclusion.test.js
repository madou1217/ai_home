'use strict';

// 账号级路由排除：只把「Go 忠实服务不了」的账号推给 Go 排除，其余一律交给 Go。
//
// 判据不是「是不是自定义上游」，而是「Go 有没有能力用这个账号打上游」：
//   1. Provider 在所有推理入口上都没有 Go 上游（当前只有 gemini）→ no_go_upstream；
//   2. 自定义上游 + 只有 relay 通道（relay 端点是发行版级硬编码）→ custom_upstream_relay；
//   3. 其余（含自定义上游的 codex/claude，canonical 通道会用账号自己的 base_url）→ 不排除。
//
// 这条线的失效方式全是静默的：漏推 = Go 选中它服务不了的账号；多推 = 每轮几十个请求；
// 误推 = 官方账号流量全回 Node。所以判定、签名、重试三件事都要被断言住。

const test = require('node:test');
const assert = require('node:assert/strict');

const { pushAccountRoutingExclusions } = require('../lib/server/go-account-sync');
const { getProviderCredentialFacts } = require('../lib/provider-catalog');

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

// 按 Provider 凭据合同拼环境变量：不在测试里写死变量名。
function envFor(provider, baseUrl) {
  const facts = getProviderCredentialFacts(provider);
  const env = {};
  const apiKey = (facts.apiKeyEnv || [])[0];
  const authToken = (facts.authTokenEnv || [])[0];
  if (apiKey) env[apiKey] = 'sk-test';
  else if (authToken) env[authToken] = 'token-test';
  if (baseUrl) {
    const baseKey = (facts.baseUrlEnv || [])[0];
    if (baseKey) env[baseKey] = baseUrl;
  }
  return env;
}

function accountFor(provider, baseUrl, overrides = {}) {
  return {
    provider,
    accountRef: 'acct_node1',
    env: envFor(provider, baseUrl),
    state: { apiKeyMode: true },
    ...overrides
  };
}

test('gemini 账号（Go 没有上游）被排除，原因是 no_go_upstream', async () => {
  const client = createClient();
  const result = createResult();
  const signatures = new Map();
  await pushAccountRoutingExclusions({
    client,
    primaryByGoRef: new Map([['acct_go1', accountFor('gemini', 'https://generativelanguage.googleapis.com', { state: { apiKeyMode: true } })]]),
    pushedSignatures: signatures,
    result
  });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, 'PUT');
  assert.equal(client.calls[0].path, '/v1/management/accounts/acct_go1/routing');
  assert.deepEqual(client.calls[0].body, { excluded: true, reason: 'no_go_upstream' });
  assert.equal(signatures.get('acct_go1'), 'excluded:no_go_upstream');
});

test('自定义上游的 codex 账号不排除（canonical 通道会用账号自己的 base_url）', async () => {
  const client = createClient();
  const result = createResult();
  await pushAccountRoutingExclusions({
    client,
    primaryByGoRef: new Map([['acct_go1', accountFor('codex', 'https://proxy.example.com/v1')]]),
    pushedSignatures: new Map(),
    result
  });
  assert.equal(client.calls.length, 0);
  assert.equal(result.routingExclusionsPushed, 0);
});

test('自定义上游的 relay 账号被排除（relay 端点是硬编码的）', async () => {
  const client = createClient();
  const result = createResult();
  await pushAccountRoutingExclusions({
    client,
    primaryByGoRef: new Map([['acct_go1', accountFor('zcode', 'https://relay.example.com')]]),
    pushedSignatures: new Map(),
    result
  });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].body, { excluded: true, reason: 'custom_upstream_relay' });
});

test('官方端点账号一个请求都不发', async () => {
  const client = createClient();
  const result = createResult();
  await pushAccountRoutingExclusions({
    client,
    primaryByGoRef: new Map([
      ['acct_go_official', accountFor('codex', 'https://api.openai.com/v1')],
      ['acct_go_default', accountFor('codex', '')],
      ['acct_go_oauth', accountFor('codex', 'https://proxy.example.com/v1', { state: { apiKeyMode: false } })]
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
    primaryByGoRef: new Map([['acct_go1', accountFor('gemini', 'https://generativelanguage.googleapis.com')]]),
    pushedSignatures: signatures,
    result
  };
  await pushAccountRoutingExclusions(options);
  await pushAccountRoutingExclusions(options);
  assert.equal(client.calls.length, 1, '第二轮应被判重');
  assert.equal(result.routingExclusionsPushed, 1);
});

test('从排除翻回放行时推 excluded=false', async () => {
  const client = createClient();
  const result = createResult();
  const signatures = new Map([['acct_go1', 'excluded:custom_upstream_relay']]);
  await pushAccountRoutingExclusions({
    client,
    primaryByGoRef: new Map([['acct_go1', accountFor('zcode', '')]]),
    pushedSignatures: signatures,
    result
  });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].body, { excluded: false, reason: '' });
  assert.equal(signatures.get('acct_go1'), 'included');
});

test('推送失败记 routing_exclusion 且不写签名，下一轮重试', async () => {
  const client = createClient([{ ok: false, errorCode: 'go_core_unavailable' }]);
  const result = createResult();
  const signatures = new Map();
  await pushAccountRoutingExclusions({
    client,
    primaryByGoRef: new Map([['acct_go1', accountFor('gemini', 'https://generativelanguage.googleapis.com')]]),
    pushedSignatures: signatures,
    result
  });
  assert.equal(result.routingExclusionsPushed, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].step, 'routing_exclusion');
  assert.equal(signatures.has('acct_go1'), false);
});

test('首圈 forceAll 会把「不排除」也推一遍，用于清掉上一进程留下的排除行', async () => {
  const client = createClient();
  const result = createResult();
  const signatures = new Map();
  await pushAccountRoutingExclusions({
    client,
    primaryByGoRef: new Map([['acct_go1', accountFor('codex', 'https://api.openai.com/v1')]]),
    pushedSignatures: signatures,
    result,
    forceAll: true
  });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].body, { excluded: false, reason: '' });
  assert.equal(signatures.get('acct_go1'), 'included');
});
