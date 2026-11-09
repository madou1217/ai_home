'use strict';

// P2 公开启停入口：/v0/plugins/enable|disable 只代理 Go；Go 不可用直接 503，不落本地状态。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { handlePluginManagementRequest } = require('../lib/server/plugin-management-routes');
const { getPluginSystem } = require('../lib/plugins/control/plugin-system');

const MANAGEMENT_KEY = 'management-test-key';

function createSession(options = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-plugin-proxy-'));
  const state = {};
  const store = options.store || {
    get: () => { throw new Error('public route must not use local control'); },
    update: () => {},
    commitRemote: async () => {}
  };
  getPluginSystem(state, { aiHomeDir, stateStore: store, providerDescriptorSync: false });
  return {
    state,
    store,
    aiHomeDir,
    cleanup: () => fs.rmSync(aiHomeDir, { recursive: true, force: true })
  };
}

async function call(session, { pathname, body, deps = {} }) {
  const writes = [];
  const ctx = {
    method: 'POST',
    pathname,
    req: Object.assign(Readable.from([Buffer.from(JSON.stringify(body || {}))]), {
      url: pathname,
      headers: { authorization: `Bearer ${MANAGEMENT_KEY}` },
      socket: { remoteAddress: '127.0.0.1' }
    }),
    res: {},
    state: session.state,
    requiredManagementKey: MANAGEMENT_KEY,
    deps: {
      writeJson: (_res, status, payload) => writes.push({ status, payload }),
      aiHomeDir: session.aiHomeDir,
      ...deps
    }
  };
  await handlePluginManagementRequest(ctx);
  return writes;
}

test('公开 enable 代理 Go，不触碰本地 control', async () => {
  const session = createSession();
  const calls = [];
  const writes = await call(session, {
    pathname: '/v0/plugins/enable',
    body: { pluginId: 'echo' },
    deps: {
      goCoreSync: {
        enablePlugin: async (...args) => {
          calls.push(args);
          return { ok: true, status: 200, body: { ok: true, revision: 5, generation: 2, state: 'active' } };
        }
      }
    }
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 200);
  assert.equal(writes[0].payload.revision, 5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'echo');
  session.cleanup();
});

test('公开 disable：Go 不可用返回 503，revision 不变', async () => {
  const session = createSession();
  const writes = await call(session, {
    pathname: '/v0/plugins/disable',
    body: { instanceId: 'echo' },
    deps: {
      goCoreSync: {
        disablePlugin: async () => ({ ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' })
      }
    }
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].status, 503);
  assert.equal(writes[0].payload.error, 'go_core_unavailable');
  session.cleanup();
});

test('公开 enable 缺少 pluginId 直接 400，不调用 Go', async () => {
  const session = createSession();
  const writes = await call(session, {
    pathname: '/v0/plugins/enable',
    body: {},
    deps: { goCoreSync: { enablePlugin: async () => { throw new Error('must not call Go'); } } }
  });
  assert.equal(writes[0].status, 400);
  assert.equal(writes[0].payload.error, 'plugin_id_required');
  session.cleanup();
});

test('公开 disable 缺少 instanceId 返回 404 plugin_instance_unknown', async () => {
  const session = createSession();
  const writes = await call(session, {
    pathname: '/v0/plugins/disable',
    body: {},
    deps: { goCoreSync: { disablePlugin: async () => { throw new Error('must not call Go'); } } }
  });
  assert.equal(writes[0].status, 404);
  assert.equal(writes[0].payload.error, 'plugin_instance_unknown');
  session.cleanup();
});
