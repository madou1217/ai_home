'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { pushAccountProbes } = require('../lib/server/go-account-sync');

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
  return { probePushed: 0, errors: [] };
}

test('推送变化的探针结果', async () => {
  const client = createClient();
  const result = createResult();
  const signatures = new Map();
  await pushAccountProbes({
    client,
    primaryByGoRef: new Map([['acct_go1', { provider: 'codex', accountRef: 'acct_node1' }]]),
    probeState: () => ({ checkedAt: 1000, error: '' }),
    pushedSignatures: signatures,
    result
  });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, 'PATCH');
  assert.equal(client.calls[0].path, '/v1/management/accounts/acct_go1/probe');
  assert.deepEqual(client.calls[0].body, { status: 'ok', error: '', checked_at_ms: 1000 });
  assert.equal(result.probePushed, 1);
  assert.equal(signatures.get('acct_go1'), '1000:');
});

test('同一份结果不重复推送', async () => {
  const client = createClient();
  const result = createResult();
  const signatures = new Map();
  const options = {
    client,
    primaryByGoRef: new Map([['acct_go1', { provider: 'codex', accountRef: 'acct_node1' }]]),
    probeState: () => ({ checkedAt: 1000, error: '' }),
    pushedSignatures: signatures,
    result
  };
  await pushAccountProbes(options);
  await pushAccountProbes(options);
  assert.equal(client.calls.length, 1, '第二轮应被判重');
  assert.equal(result.probePushed, 1);

  // checkedAt 变了就再推一次。
  options.probeState = () => ({ checkedAt: 2000, error: '' });
  await pushAccountProbes(options);
  assert.equal(client.calls.length, 2);
  assert.equal(result.probePushed, 2);
});

test('探针带错误时 status=error', async () => {
  const client = createClient();
  const result = createResult();
  await pushAccountProbes({
    client,
    primaryByGoRef: new Map([['acct_go1', { provider: 'claude', accountRef: 'acct_node1' }]]),
    probeState: () => ({ checkedAt: 5, error: '401 invalid token' }),
    pushedSignatures: new Map(),
    result
  });
  assert.equal(client.calls[0].body.status, 'error');
  assert.equal(client.calls[0].body.error, '401 invalid token');
});

test('没有探针结果或读取抛错时跳过', async () => {
  const client = createClient();
  const result = createResult();
  await pushAccountProbes({
    client,
    primaryByGoRef: new Map([['acct_go1', { provider: 'codex', accountRef: 'acct_node1' }]]),
    probeState: () => null,
    pushedSignatures: new Map(),
    result
  });
  await pushAccountProbes({
    client,
    primaryByGoRef: new Map([['acct_go1', { provider: 'codex', accountRef: 'acct_node1' }]]),
    probeState: () => {
      throw new Error('boom');
    },
    pushedSignatures: new Map(),
    result
  });
  assert.equal(client.calls.length, 0);
  assert.equal(result.errors.length, 0);
});

test('推送失败记录错误且不写签名', async () => {
  const client = createClient([{ ok: false, errorCode: 'go_core_unavailable' }]);
  const result = createResult();
  const signatures = new Map();
  await pushAccountProbes({
    client,
    primaryByGoRef: new Map([['acct_go1', { provider: 'codex', accountRef: 'acct_node1' }]]),
    probeState: () => ({ checkedAt: 1, error: '' }),
    pushedSignatures: signatures,
    result
  });
  assert.equal(result.probePushed, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].step, 'probe');
  assert.equal(signatures.has('acct_go1'), false, '失败不应写签名，否则下一轮不再重试');
});
