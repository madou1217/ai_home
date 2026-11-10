'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { callGoHost, proxyGo, writeGoFailure } = require('../lib/server/webui-go-proxy');

function makeCtx(goHost, method = 'GET') {
  let captured;
  return {
    get captured() { return captured; },
    ctx: {
      method,
      pathname: '/v0/webui/test',
      res: {},
      deps: goHost === undefined ? {} : { goCoreSync: goHost },
      writeJson: (_res, status, payload) => { captured = { status, payload }; }
    }
  };
}

test('proxyGo：成功原样透传 data', async () => {
  const state = makeCtx({ getThing: async () => ({ ok: true, status: 200, data: { value: 1 } }) });
  await proxyGo(state.ctx, { method: 'getThing' });
  assert.deepEqual(state.captured, { status: 200, payload: { value: 1 } });
});

test('proxyGo：transform 改写成功响应', async () => {
  const state = makeCtx({ getThing: async () => ({ ok: true, status: 200, data: { value: 1 } }) });
  await proxyGo(state.ctx, { method: 'getThing', transform: (data) => ({ ...data, extra: true }) });
  assert.deepEqual(state.captured.payload, { value: 1, extra: true });
});

test('proxyGo：passStatuses 原样透传，其余 503', async () => {
  const denied = makeCtx({ getThing: async () => ({ ok: false, status: 404, data: { ok: false, error: 'not_found' } }) });
  await proxyGo(denied.ctx, { method: 'getThing' });
  assert.equal(denied.captured.status, 404);

  const broken = makeCtx({ getThing: async () => ({ ok: false, status: 500, data: { ok: false, error: 'boom' } }) });
  await proxyGo(broken.ctx, { method: 'getThing', message: '读失败' });
  assert.equal(broken.captured.status, 503);
  assert.equal(broken.captured.payload.error, 'boom');
  assert.equal(broken.captured.payload.message, '读失败');
});

test('callGoHost：宿主缺失/抛错都返回 response=null', async () => {
  const missing = await callGoHost({ deps: {} }, 'getThing');
  assert.equal(missing.available, false);

  const throwing = await callGoHost({ deps: { goCoreSync: { getThing: async () => { throw new Error('x'); } } } }, 'getThing');
  assert.equal(throwing.available, true);
  assert.equal(throwing.response, null);
});

test('writeGoFailure：fallbackStatus 可覆盖', () => {
  const state = makeCtx({});
  writeGoFailure(state.ctx, null, { fallbackStatus: 500, fallbackCode: 'write_failed' });
  assert.equal(state.captured.status, 500);
  assert.equal(state.captured.payload.error, 'write_failed');
});
