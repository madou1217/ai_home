'use strict';

// WebUI 收件箱（GET /v0/webui/peer/messages）的回归守卫。
//
// 这条接口是纯读：一旦它开始 claim/rename，真正的投递者就再也抢不到消息。
// 所以除了字段投影，还要锁住「读完之后 store 状态不变」。

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');

const { createPeerStore } = require('../lib/cli/services/peer/store');
const { handleWebUiPeerRoutes } = require('../lib/server/webui-peer-routes');

function withTempAiHome(run) {
  const aiHomeDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'aih-webui-peer-'));
  try {
    return run(aiHomeDir);
  } finally {
    nodeFs.rmSync(aiHomeDir, { recursive: true, force: true });
  }
}

function callRoute({ aiHomeDir, method = 'GET', pathname = '/v0/webui/peer/messages', search = '' }) {
  const captured = { code: 0, payload: null };
  const handled = handleWebUiPeerRoutes({
    method,
    pathname,
    url: new URL(`http://local${pathname}${search}`),
    aiHomeDir,
    res: {},
    writeJson: (_res, code, payload) => { captured.code = code; captured.payload = payload; }
  });
  return { handled, ...captured };
}

function seed(aiHomeDir, body) {
  const store = createPeerStore({ aiHomeDir });
  return store.createMessage({
    from: { channel: 'inject', provider: 'codebuddy', name: 'sender-a', address: 'sender-a' },
    to: {
      channel: 'inject',
      provider: 'codebuddycn',
      name: 'receiver-b',
      address: 'receiver-b',
      delivery: { cliName: 'codebuddycn', runtimeScope: 'acct_9dc03880a872f711983e', sessionName: 'receiver-b' }
    },
    body
  });
}

test('webui-peer-inbox：按最新在上返回消息，并带 from/to/state 投影', () => {
  withTempAiHome((aiHomeDir) => {
    seed(aiHomeDir, 'first');
    seed(aiHomeDir, 'second');

    const result = callRoute({ aiHomeDir });
    assert.equal(result.handled, true);
    assert.equal(result.code, 200);
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.counts.total, 2);
    assert.equal(result.payload.counts.pending, 2);
    assert.deepEqual(result.payload.messages.map((m) => m.body), ['second', 'first']);

    const latest = result.payload.messages[0];
    assert.equal(latest.from.name, 'sender-a');
    assert.equal(latest.to.name, 'receiver-b');
    assert.equal(latest.to.provider, 'codebuddycn');
    assert.equal(latest.state, 'pending');
    assert.equal(latest.shortId.startsWith('pm-'), true);
  });
});

test('webui-peer-inbox：只读——查询不会抢走待投递消息', () => {
  withTempAiHome((aiHomeDir) => {
    const record = seed(aiHomeDir, 'do-not-claim-me');
    const result = callRoute({ aiHomeDir });
    assert.equal(result.code, 200);
    assert.equal(result.payload.messages[0].id, record.id);

    const store = createPeerStore({ aiHomeDir });
    const stillPending = store.listMessages({ state: 'pending' });
    assert.equal(stillPending.length, 1);
    assert.equal(stillPending[0].id, record.id);
    // claim 仍然能抢到，说明上面的查询没有动过文件。
    assert.equal(store.claim(record.id).record.id, record.id);
  });
});

test('webui-peer-inbox：state 过滤与失败原因', () => {
  withTempAiHome((aiHomeDir) => {
    const record = seed(aiHomeDir, 'boom');
    const store = createPeerStore({ aiHomeDir });
    store.claim(record.id);
    store.settleFailed(record, 'session_gone');

    const all = callRoute({ aiHomeDir });
    assert.equal(all.payload.counts.failed, 1);
    assert.equal(all.payload.messages[0].state, 'failed');
    assert.equal(all.payload.messages[0].error, 'session_gone');

    const filtered = callRoute({ aiHomeDir, search: '?state=failed' });
    assert.equal(filtered.payload.messages.length, 1);
    const empty = callRoute({ aiHomeDir, search: '?state=pending' });
    assert.equal(empty.payload.messages.length, 0);
  });
});

test('webui-peer-inbox：不匹配的路径/方法交还给别的路由', () => {
  withTempAiHome((aiHomeDir) => {
    assert.equal(callRoute({ aiHomeDir, pathname: '/v0/webui/peer/other' }).handled, false);
    assert.equal(callRoute({ aiHomeDir, method: 'POST' }).handled, false);
  });
});

test('webui-peer-inbox：缺少 aiHomeDir 时回 503 而不是抛错', () => {
  const result = callRoute({ aiHomeDir: '' });
  assert.equal(result.handled, true);
  assert.equal(result.code, 503);
  assert.equal(result.payload.error, 'peer_store_unavailable');
});
