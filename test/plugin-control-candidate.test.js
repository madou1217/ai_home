'use strict';

// P2 候选语义仍归 Node：configSchema 默认值、权限门、实例冲突与指纹必须与迁 Go 之前一致。
// 这里锁住 prepare 阶段（不写状态、不写审计），以及 activate 成功后才写一次审计。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPluginControl, permissionFingerprint } = require('../lib/plugins/control/control');

function baseManifest(overrides = {}) {
  return {
    pluginId: 'echo',
    version: '1.0.0',
    entry: 'index.js',
    contributes: [],
    permissions: { network: [], filesystem: { read: [], write: [] }, secrets: [], environment: [] },
    ...overrides
  };
}

function createState(manifest) {
  return {
    schemaVersion: 1,
    revision: 4,
    installed: [{
      pluginId: 'echo',
      version: '1.0.0',
      digest: 'digest-1',
      artifact: '/tmp/accepted/digest-1.aih-plugin',
      directory: '/tmp/extracted/digest-1',
      manifest,
      installedAt: 1,
      signature: { status: 'unsigned' },
      permissionsFingerprint: permissionFingerprint(manifest)
    }],
    instances: [],
    generations: [],
    activeGeneration: 0
  };
}

function createControl(options = {}) {
  const state = options.state || createState(options.manifest || baseManifest());
  const commits = [];
  const audits = [];
  const runtimeCalls = [];
  let ticketSeq = 0;
  const store = {
    get: () => JSON.parse(JSON.stringify(state)),
    update: () => { throw new Error('prepare 不得本地写状态'); },
    commitRemote: async (candidate, expected, operation) => {
      commits.push({ candidate, expected, operation });
      return { ...candidate, revision: expected + 1 };
    }
  };
  const runtime = {
    prepare: async (plugins) => {
      runtimeCalls.push({ method: 'prepare', plugins });
      ticketSeq += 1;
      return { ticket: `ticket-${ticketSeq}`, generation: ticketSeq, contributions: [] };
    },
    activate: async (ticket, revision) => {
      runtimeCalls.push({ method: 'activate', ticket, revision });
      return { generation: ticketSeq, state: 'active', revision };
    },
    discard: async (ticket, reason) => {
      runtimeCalls.push({ method: 'discard', ticket, reason });
      return { ok: true };
    }
  };
  const control = createPluginControl({
    aiHomeDir: '/tmp/plugin-candidate-test',
    hostVersion: '1.0.0',
    stateStore: store,
    runtime,
    audit: { append: (event, details) => audits.push({ event, details }) }
  });
  return { control, store, runtime, runtimeCalls, commits, audits };
}

test('prepare enable：configSchema 默认值、实例启用与权限指纹都进候选，且不写审计', async () => {
  const manifest = baseManifest({
    configSchema: {
      type: 'object',
      properties: { token: { type: 'string', default: 'auto' } },
      additionalProperties: false
    },
    permissions: { network: ['https://api.example.com'], filesystem: { read: [], write: [] }, secrets: [], environment: [] }
  });
  const { control, runtimeCalls, commits, audits } = createControl({ manifest });
  const prepared = await control.prepareInstance('enable', {
    pluginId: 'echo',
    acceptPermissions: true,
    configuration: {}
  }, 4);
  assert.equal(prepared.candidate.revision, 5);
  assert.equal(prepared.expectedRevision, 4);
  const instance = prepared.candidate.instances.find((item) => item.instanceId === 'echo');
  assert.equal(instance.enabled, true);
  assert.equal(instance.configuration.token, 'auto');
  assert.equal(instance.permissionsAcceptedFingerprint, permissionFingerprint(manifest));
  assert.equal(commits.length, 0);
  assert.equal(audits.length, 0);
  assert.deepEqual(runtimeCalls.map((item) => item.method), ['prepare']);

  const activated = await control.activateChange(prepared.ticket, 5);
  assert.equal(activated.state, 'active');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].event, 'enable');
  assert.equal(audits[0].details.instanceId, 'echo');
});

test('prepare enable：未确认权限直接拒绝，不调用宿主', async () => {
  const manifest = baseManifest({
    permissions: { network: ['https://api.example.com'], filesystem: { read: [], write: [] }, secrets: [], environment: [] }
  });
  const { control, runtimeCalls } = createControl({ manifest });
  await assert.rejects(
    async () => control.prepareInstance('enable', { pluginId: 'echo' }, 4),
    (error) => error && error.code === 'plugin_permissions_unacknowledged'
  );
  assert.equal(runtimeCalls.length, 0);
});

test('prepare enable：配置不符合 configSchema 拒绝，不返回票据', async () => {
  const manifest = baseManifest({
    configSchema: {
      type: 'object',
      properties: { token: { type: 'string' } },
      additionalProperties: false
    }
  });
  const { control, runtimeCalls } = createControl({ manifest });
  await assert.rejects(
    async () => control.prepareInstance('enable', { pluginId: 'echo', configuration: { token: 1 } }, 4),
    (error) => error && error.code === 'plugin_config_invalid'
  );
  assert.equal(runtimeCalls.length, 0);
});

test('prepare disable：未知实例与未知 operation 返回原错误码', async () => {
  const { control, runtimeCalls } = createControl();
  await assert.rejects(
    async () => control.prepareInstance('disable', { instanceId: 'ghost' }, 4),
    (error) => error && error.code === 'plugin_instance_unknown'
  );
  await assert.rejects(
    async () => control.prepareInstance('upgrade', {}, 4),
    (error) => error && error.code === 'plugin_operation_invalid'
  );
  assert.equal(runtimeCalls.length, 0);
});

test('prepare 与 Go 的 expectedRevision 不一致时拒绝，不调用宿主', async () => {
  const { control, runtimeCalls } = createControl();
  await assert.rejects(
    async () => control.prepareInstance('enable', { pluginId: 'echo' }, 3),
    (error) => error && error.code === 'plugin_revision_conflict'
  );
  assert.equal(runtimeCalls.length, 0);
});
