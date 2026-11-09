'use strict';

// P2 内部发布协议：只接受回环 + 管理密钥；prepare 只构建候选，不写状态；activate 成功才写审计。
// 公开的 /v0/plugins/enable|disable 必须代理 Go，Go 不可用直接 503，不做本地兜底。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');

const { handlePluginManagementRequest } = require('../lib/server/plugin-management-routes');
const { getPluginSystem } = require('../lib/plugins/control/plugin-system');

const MANAGEMENT_KEY = 'management-test-key';

function createState(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 3,
    installed: [{
      pluginId: 'echo',
      version: '1.0.0',
      digest: 'digest-1',
      artifact: '/tmp/plugins/accepted/digest-1.aih-plugin',
      directory: '/tmp/plugins/extracted/digest-1',
      manifest: {
        pluginId: 'echo',
        version: '1.0.0',
        entry: 'index.js',
        contributes: [{ id: 'echo.reply', capability: 'gateway.request' }],
        permissions: { network: [], filesystem: { read: [], write: [] }, secrets: [], environment: [] }
      },
      installedAt: 1,
      signature: { status: 'unsigned' },
      permissionsFingerprint: ''
    }],
    instances: [],
    generations: [],
    activeGeneration: 0,
    ...overrides
  };
}

function createStore(state) {
  const commits = [];
  return {
    commits,
    get: () => state,
    update: () => { throw new Error('内部 prepare 不得本地写状态'); },
    commitRemote: async (...args) => { commits.push(args); throw new Error('Node 不得提交状态'); }
  };
}

function createSupervisor(options = {}) {
  const calls = [];
  return {
    calls,
    async call(method, payload) {
      calls.push({ method, payload });
      if (method === 'prepare') {
        return { value: options.reject
          ? { state: 'rejected', diagnostics: [{ code: 'plugin_apply_failed', detail: 'apply boom' }] }
          : { state: 'prepared', contributions: [{ id: 'echo.reply' }] } };
      }
      if (method === 'activate') return { value: { state: 'active' } };
      if (method === 'dispose') return { value: { state: 'disposed' } };
      if (method === 'invoke') return { value: null };
      throw new Error(`unexpected host call: ${method}`);
    },
    status: () => ({ running: true, pid: 999 }),
    async stop() {}
  };
}

// 一个会话对应一份插件系统（WeakMap 以 state 为键）；同一测试里的 prepare/activate 必须共用它。
function createSession(options = {}) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-plugin-internal-'));
  const state = {};
  const store = options.store || createStore(options.storeState || createState());
  const supervisor = options.supervisor || createSupervisor();
  const system = getPluginSystem(state, {
    aiHomeDir,
    stateStore: store,
    supervisorFactory: () => supervisor,
    providerDescriptorSync: false
  });
  return {
    state,
    store,
    supervisor,
    system,
    aiHomeDir,
    cleanup: () => fs.rmSync(aiHomeDir, { recursive: true, force: true })
  };
}

function createContext(session, options = {}) {
  const writes = [];
  const body = options.body === undefined ? {} : options.body;
  const headers = options.authorization === null
    ? {}
    : { authorization: `Bearer ${options.authorization || MANAGEMENT_KEY}` };
  const ctx = {
    method: options.method || 'POST',
    pathname: options.pathname,
    req: Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      url: options.pathname,
      headers,
      socket: { remoteAddress: options.remoteAddress || '127.0.0.1' }
    }),
    res: {},
    state: session.state,
    requiredManagementKey: MANAGEMENT_KEY,
    deps: {
      writeJson: (_res, status, payload) => writes.push({ status, payload }),
      aiHomeDir: session.aiHomeDir,
      ...(options.deps || {})
    }
  };
  return { ctx, writes };
}

async function call(session, options) {
  const context = createContext(session, options);
  await handlePluginManagementRequest(context.ctx);
  return context;
}

function prepareBody(overrides = {}) {
  return {
    operation: 'enable',
    expectedRevision: 3,
    input: { pluginId: 'echo', acceptPermissions: true },
    ...overrides
  };
}

test('internal/prepare：回环 + 管理密钥通过，返回候选且不写状态', async () => {
  const session = createSession();
  const result = await call(session, { pathname: '/v0/plugins/internal/prepare', body: prepareBody() });
  assert.equal(result.writes.length, 1);
  const write = result.writes[0];
  assert.equal(write.status, 200);
  assert.ok(write.payload.ticket);
  assert.equal(write.payload.generation, 1);
  assert.equal(write.payload.candidate.revision, 4);
  assert.equal(write.payload.candidate.instances[0].enabled, true);
  assert.equal(session.store.commits.length, 0);
  session.cleanup();
});

test('internal/prepare：非回环地址 403，且不读状态', async () => {
  const failingStore = { get: () => { throw new Error('must not read state'); }, update: () => {}, commitRemote: async () => {} };
  const session = createSession({ store: failingStore });
  const result = await call(session, {
    pathname: '/v0/plugins/internal/prepare',
    body: prepareBody(),
    remoteAddress: '10.1.2.3'
  });
  assert.equal(result.writes[0].status, 403);
  assert.equal(result.writes[0].payload.error, 'plugin_internal_loopback_required');
  session.cleanup();
});

test('internal/prepare：缺少管理密钥 401', async () => {
  const session = createSession();
  const result = await call(session, {
    pathname: '/v0/plugins/internal/prepare',
    body: prepareBody(),
    authorization: null
  });
  assert.equal(result.writes[0].status, 401);
  session.cleanup();
});

test('internal/prepare：回环 + Go Core 引导密钥也能通过（与 Server key 分离）', async () => {
  const session = createSession();
  const result = await call(session, {
    pathname: '/v0/plugins/internal/prepare',
    body: prepareBody(),
    authorization: 'go-core-boot-key',
    deps: { goCoreManagementKey: () => 'go-core-boot-key' }
  });
  assert.equal(result.writes[0].status, 200);
  assert.ok(result.writes[0].payload.ticket);
  session.cleanup();
});

test('internal/prepare：候选被拒返回原错误码与 diagnostics', async () => {
  const session = createSession({ supervisor: createSupervisor({ reject: true }) });
  const result = await call(session, { pathname: '/v0/plugins/internal/prepare', body: prepareBody() });
  assert.equal(result.writes[0].status, 400);
  assert.equal(result.writes[0].payload.error, 'plugin_candidate_rejected');
  assert.equal(result.writes[0].payload.diagnostics[0].code, 'plugin_apply_failed');
  session.cleanup();
});

test('internal/prepare：并发第二个请求 409 plugin_publish_busy，discard 后恢复', async () => {
  const session = createSession();
  const first = await call(session, { pathname: '/v0/plugins/internal/prepare', body: prepareBody() });
  assert.equal(first.writes[0].status, 200);
  const second = await call(session, { pathname: '/v0/plugins/internal/prepare', body: prepareBody() });
  assert.equal(second.writes[0].status, 409);
  assert.equal(second.writes[0].payload.error, 'plugin_publish_busy');

  const discarded = await call(session, {
    pathname: '/v0/plugins/internal/discard',
    body: { ticket: first.writes[0].payload.ticket, reason: 'test' }
  });
  assert.equal(discarded.writes[0].status, 200);
  const third = await call(session, { pathname: '/v0/plugins/internal/prepare', body: prepareBody() });
  assert.equal(third.writes[0].status, 200);
  await call(session, { pathname: '/v0/plugins/internal/discard', body: { ticket: third.writes[0].payload.ticket } });
  session.cleanup();
});

test('internal/activate：成功返回代次并恰好写一条审计', async () => {
  const session = createSession();
  const prepared = await call(session, { pathname: '/v0/plugins/internal/prepare', body: prepareBody() });
  const ticket = prepared.writes[0].payload.ticket;
  const activated = await call(session, {
    pathname: '/v0/plugins/internal/activate',
    body: { ticket, revision: 4 }
  });
  assert.equal(activated.writes[0].status, 200);
  assert.equal(activated.writes[0].payload.generation, 1);
  assert.equal(activated.writes[0].payload.state, 'active');
  const audit = session.system.control.audit.read({ limit: 20 });
  assert.equal(audit.filter((item) => item.event === 'enable').length, 1);
  session.cleanup();
});
