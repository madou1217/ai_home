'use strict';

// control.enable/disable 的提交动作必须带 operation 走 store.commitRemote，
// 不能在 Node 本地写状态。这里用 fake runtime + fake store 锁住调用契约。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPluginControl } = require('../lib/plugins/control/control');

function createState(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 3,
    installed: [{
      pluginId: 'echo',
      version: '1.0.0',
      digest: 'digest-1',
      artifact: '/tmp/accepted/digest-1.aih-plugin',
      directory: '/tmp/extracted/digest-1',
      manifest: {
        pluginId: 'echo',
        version: '1.0.0',
        entry: 'index.js',
        contributes: [],
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

function createControl(options = {}) {
  let state = options.state || createState();
  const commits = [];
  const store = {
    get: () => state,
    update: () => { throw new Error('local update must not be used for enable/disable'); },
    commitRemote: async (candidate, expected, operation) => {
      // 真实 state-store 会在这里把 revision 置为 expected+1 再交给 Go；
      // fake 必须复刻这一步，否则断言的是「未提交的候选」。
      const next = { ...candidate, revision: expected + 1 };
      commits.push({ candidate: next, expected, operation });
      state = next;
      return next;
    }
  };
  const runtime = {
    publish: async (plugins, commit) => {
      const committed = commit ? await commit() : null;
      return { committed, generation: 1, state: plugins.length ? 'active' : 'idle' };
    }
  };
  const control = createPluginControl({
    aiHomeDir: '/tmp/plugin-control-test',
    hostVersion: '1.0.0',
    stateStore: store,
    runtime,
    audit: { append() {} }
  });
  return { control, commits, getState: () => state };
}

test('control.enable：候选提交带 operation=enable', async () => {
  const { control, commits } = createControl();
  await control.enable({ pluginId: 'echo' });
  assert.equal(commits.length, 1);
  assert.equal(commits[0].operation, 'enable');
  assert.equal(commits[0].expected, 3);
  assert.equal(commits[0].candidate.revision, 4);
});

test('control.disable：候选提交带 operation=disable', async () => {
  const enabledState = createState({
    revision: 4,
    instances: [{
      instanceId: 'echo', pluginId: 'echo', version: '1.0.0', enabled: true,
      configuration: {}, createdAt: 1, updatedAt: 1
    }]
  });
  const { control, commits, getState } = createControl({ state: enabledState });
  await control.disable({ instanceId: 'echo' });
  assert.equal(commits.length, 1);
  assert.equal(commits[0].operation, 'disable');
  const instance = getState().instances.find((item) => item.instanceId === 'echo');
  assert.equal(instance.enabled, false);
});
