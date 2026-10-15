'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PROJECTION_METHODS,
  notifyGoCoreProjection,
  resolveGoCoreSync
} = require('../lib/server/go-core-projection-sync');

test('each projection name maps to exactly one go-core-host push method', () => {
  assert.deepEqual(Object.keys(PROJECTION_METHODS).sort(), ['modelAliases', 'upstreamErrorRules']);
  assert.equal(PROJECTION_METHODS.modelAliases, 'pushModelAliases');
  assert.equal(PROJECTION_METHODS.upstreamErrorRules, 'pushUpstreamErrorRules');
});

test('the sync entry resolves from the route ctx itself or its deps', () => {
  const host = { pushModelAliases: () => {} };
  assert.equal(resolveGoCoreSync({ goCoreSync: host }), host);
  assert.equal(resolveGoCoreSync({ deps: { goCoreSync: host } }), host);
  assert.equal(resolveGoCoreSync({}), null);
  assert.equal(resolveGoCoreSync(null), null);
});

test('notifyGoCoreProjection pushes the requested projection without blocking the caller', async () => {
  const calls = [];
  const ctx = { deps: { goCoreSync: {
    pushModelAliases: async () => { calls.push('aliases'); },
    pushUpstreamErrorRules: async () => { calls.push('rules'); }
  } } };
  assert.equal(await notifyGoCoreProjection(ctx, 'upstreamErrorRules'), true);
  assert.equal(await notifyGoCoreProjection(ctx, 'modelAliases'), true);
  assert.deepEqual(calls, ['rules', 'aliases']);
});

test('a missing or failing projection push never throws into the edit path', async () => {
  // 未装配（旧宿主 / 测试替身 / Go 未启用）：安静跳过。
  assert.equal(await notifyGoCoreProjection({}, 'upstreamErrorRules'), false);
  assert.equal(await notifyGoCoreProjection({ deps: { goCoreSync: {} } }, 'upstreamErrorRules'), false);
  // 未知投影名：不猜、不推。
  assert.equal(await notifyGoCoreProjection({ goCoreSync: { pushModelAliases: () => {} } }, 'nope'), false);
  // 推送失败：吞掉异常，编辑已经落盘，兜底定时器会补上。
  const failing = { goCoreSync: { pushUpstreamErrorRules: () => { throw new Error('go_down'); } } };
  assert.equal(await notifyGoCoreProjection(failing, 'upstreamErrorRules'), false);
  const rejecting = { goCoreSync: { pushUpstreamErrorRules: () => Promise.reject(new Error('go_down')) } };
  assert.equal(await notifyGoCoreProjection(rejecting, 'upstreamErrorRules'), false);
});
