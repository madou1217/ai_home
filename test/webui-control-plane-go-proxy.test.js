'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleWebUiControlPlaneRoutes } = require('../lib/server/webui-control-plane-routes');

function makeCtx(options = {}) {
  let captured;
  const calls = [];
  const goHost = options.goHost === null ? undefined : {
    getControlPlaneProfiles: async () => (calls.push(['get']), options.result),
    saveControlPlaneProfile: async (payload) => (calls.push(['save', payload]), options.result),
    setActiveControlPlaneProfile: async (id) => (calls.push(['active', id]), options.result),
    removeControlPlaneProfile: async (id) => (calls.push(['remove', id]), options.result),
    getControlPlaneEndpoints: async (params) => (calls.push(['endpoints', params]), options.result)
  };
  return {
    calls,
    get captured() { return captured; },
    ctx: {
      method: options.method || 'GET',
      pathname: options.pathname || '/v0/webui/control-plane/profiles',
      req: { headers: options.headers || { host: '127.0.0.1:9527' }, method: options.method || 'GET' },
      options: { host: '127.0.0.1', port: 9527 },
      res: {},
      deps: goHost ? { goCoreSync: goHost } : {},
      readRequestBody: async () => Buffer.from(options.body === undefined ? '{}' : options.body, 'utf8'),
      writeJson: (_res, status, payload) => { captured = { status, payload }; }
    }
  };
}

test('control-plane profiles GET 代理 Go', async () => {
  const data = { ok: true, profiles: [], activeProfileId: '' };
  const state = makeCtx({ result: { ok: true, status: 200, data } });
  await handleWebUiControlPlaneRoutes(state.ctx);
  assert.equal(state.captured.status, 200);
  assert.deepEqual(state.captured.payload, data);
});

test('control-plane profiles POST/active/DELETE 代理 Go', async () => {
  const data = { ok: true, profiles: [], activeProfileId: '' };
  const save = makeCtx({ method: 'POST', body: '{"profile":{"endpoint":"x"}}', result: { ok: true, status: 200, data } });
  await handleWebUiControlPlaneRoutes(save.ctx);
  assert.deepEqual(save.calls[0], ['save', { profile: { endpoint: 'x' } }]);

  const active = makeCtx({ method: 'POST', pathname: '/v0/webui/control-plane/profiles/active', body: '{"profileId":"p1"}', result: { ok: true, status: 200, data } });
  await handleWebUiControlPlaneRoutes(active.ctx);
  assert.deepEqual(active.calls[0], ['active', 'p1']);

  const remove = makeCtx({ method: 'DELETE', pathname: '/v0/webui/control-plane/profiles/p1', result: { ok: true, status: 200, data } });
  await handleWebUiControlPlaneRoutes(remove.ctx);
  assert.deepEqual(remove.calls[0], ['remove', 'p1']);
});

test('control-plane endpoints 转发请求地址与绑定 host', async () => {
  const data = { ok: true, endpoints: [], warnings: [] };
  const state = makeCtx({ method: 'GET', pathname: '/v0/webui/control-plane/endpoints', result: { ok: true, status: 200, data } });
  await handleWebUiControlPlaneRoutes(state.ctx);
  assert.deepEqual(state.calls[0], ['endpoints', { endpoint: 'http://127.0.0.1:9527', host: '127.0.0.1', port: 9527 }]);
  assert.equal(state.captured.status, 200);
});

test('control-plane 缺少 Go 宿主时 503', async () => {
  const state = makeCtx({ goHost: null });
  await handleWebUiControlPlaneRoutes(state.ctx);
  assert.equal(state.captured.status, 503);
  assert.equal(state.captured.payload.error, 'go_core_unavailable');
});
