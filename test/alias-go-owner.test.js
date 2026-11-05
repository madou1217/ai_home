'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { aliasRoutesGoOwned, handleAliasRouteViaGo } = require('../lib/server/alias-go-owner');
const { loadAliases } = require('../lib/server/model-alias-store');

function createHarness(t, goHost, { aliases = [] } = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-alias-go-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const state = { modelAliases: { aliases } };
  const write = async (method, pathname, body) => {
    const res = { statusCode: 0, payload: null };
    const handled = await handleAliasRouteViaGo({
      req: {},
      res,
      method,
      pathname,
      state,
      deps: {
        fs,
        aiHomeDir,
        goCoreSync: goHost,
        readRequestBody: async () => Buffer.from(body === undefined ? '' : JSON.stringify(body)),
        writeJson: (target, status, payload) => { target.statusCode = status; target.payload = payload; }
      }
    });
    return { handled, res, state };
  };
  return { write, aiHomeDir, state };
}

function fakeHost(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, payload: args.length === 1 ? args[0] : args });
    return { ok: true, status: 200, data: { alias: { id: 'new1', alias: 'a', target: 'b' }, aliases: [], removed: 1 } };
  };
  const host = {
    isEnabled: () => true,
    listModelAliases: record('list'),
    createModelAlias: record('create'),
    updateModelAlias: record('update'),
    deleteModelAlias: record('delete'),
    setModelAliasEnabled: record('enabled'),
    replaceModelAliases: record('replace')
  };
  return Object.assign(host, { calls }, overrides);
}

test('Go 可用时接管写入口', () => {
  assert.equal(aliasRoutesGoOwned({ goCoreSync: fakeHost() }), true);
  assert.equal(aliasRoutesGoOwned({ goCoreSync: { ...fakeHost(), isEnabled: () => false } }), false);
  assert.equal(aliasRoutesGoOwned({}), false);
});

test('create 调 Go 并返回 alias', async (t) => {
  const host = fakeHost();
  const { write } = createHarness(t, host);
  const { res } = await write('POST', '/v0/webui/model-aliases', { alias: 'a', target: 'b' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.alias.id, 'new1');
  assert.equal(host.calls[0].name, 'create');
  assert.equal(host.calls[0].payload.alias, 'a');
});

test('delete 返回 ok 且不泄漏额外字段', async (t) => {
  const { write } = createHarness(t, fakeHost());
  const { res } = await write('DELETE', '/v0/webui/model-aliases/abc123');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { ok: true });
});

test('toggle 读取当前值后取反传给 Go', async (t) => {
  const host = fakeHost();
  const { write } = createHarness(t, host, { aliases: [{ id: 'abc123', alias: 'a', target: 'b', enabled: true }] });
  const { res } = await write('POST', '/v0/webui/model-aliases/abc123/toggle');
  assert.equal(res.statusCode, 200);
  const enabledCall = host.calls.find((call) => call.name === 'enabled');
  assert.ok(enabledCall, '没有调用 setModelAliasEnabled');
  assert.deepEqual(enabledCall.payload, ['abc123', false]);
});

test('replace 返回 removed 与新建记录', async (t) => {
  const { write } = createHarness(t, fakeHost());
  const { res } = await write('POST', '/v0/webui/model-aliases/replace', { replaceIds: ['x'], records: [] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.removed, 1);
  assert.deepEqual(res.payload.aliases, []);
});

test('Go 报 400 时把错误码透传出去', async (t) => {
  const host = fakeHost({
    createModelAlias: async () => ({ ok: false, status: 400, errorCode: 'alias_target_not_found' })
  });
  const { write } = createHarness(t, host);
  const { res } = await write('POST', '/v0/webui/model-aliases', { alias: 'a', target: 'b' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'alias_target_not_found');
});

test('targets 仍由 Node 处理', async (t) => {
  const { write } = createHarness(t, fakeHost());
  const { handled } = await write('GET', '/v0/webui/model-aliases/targets');
  assert.equal(handled, false);
});

test('写成功后把 Go 的列表写回本地投影', async (t) => {
  const host = fakeHost({
    deleteModelAlias: async () => ({ ok: true, status: 200, data: {} }),
    listModelAliases: async () => ({ ok: true, status: 200, data: { aliases: [{ id: 'r1', alias: 'kept', target: 'x' }] } })
  });
  const { write, aiHomeDir } = createHarness(t, host);
  await write('DELETE', '/v0/webui/model-aliases/abc123');
  const stored = await loadAliases(fs, aiHomeDir);
  assert.deepEqual(stored.aliases.map((row) => row.id), ['r1']);
});

