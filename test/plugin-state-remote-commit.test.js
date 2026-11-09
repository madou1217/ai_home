'use strict';

// enable/disable 的状态 CAS 固定走 Go：本地只做 revision 预检与候选归一。
// 这组用例锁住：候选 revision、operation 透传、冲突/Go 不可用时不写本地。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPluginStateStore } = require('../lib/plugins/control/state-store');

const BASE_STATE = Object.freeze({
  schemaVersion: 1,
  revision: 3,
  installed: [],
  instances: [],
  generations: [],
  activeGeneration: 0
});

function createStore(options = {}) {
  const commits = [];
  const store = createPluginStateStore({
    aiHomeDir: '/tmp/plugin-state-test',
    readValue: () => options.state || BASE_STATE,
    openDatabase: () => { throw new Error('local state write must not happen'); },
    remoteCommit: options.remoteCommit || (async (payload) => {
      commits.push(payload);
      return { ok: true, status: 200, data: { ok: true, revision: payload.candidate.revision } };
    })
  });
  return { store, commits };
}

test('commitRemote：候选 revision = expected+1，operation 原样传给 Go', async () => {
  const { store, commits } = createStore();
  const candidate = { schemaVersion: 1, revision: 3, installed: [], instances: [], generations: [] };
  const result = await store.commitRemote(candidate, 3, 'enable');
  assert.equal(commits.length, 1);
  assert.equal(commits[0].operation, 'enable');
  assert.equal(commits[0].expectedRevision, 3);
  assert.equal(commits[0].candidate.revision, 4);
  assert.equal(result.revision, 4);
});

test('commitRemote：expected 不一致时不调用 Go', async () => {
  const { store, commits } = createStore({ state: { ...BASE_STATE, revision: 7 } });
  await assert.rejects(
    () => store.commitRemote({ ...BASE_STATE }, 3, 'disable'),
    (error) => error && error.code === 'plugin_revision_conflict'
  );
  assert.equal(commits.length, 0);
});

test('commitRemote：Go 409 透传 revision，不写本地', async () => {
  const { store } = createStore({
    remoteCommit: async () => ({
      ok: false,
      status: 409,
      data: { ok: false, error: 'plugin_revision_conflict', revision: 9 }
    })
  });
  await assert.rejects(
    () => store.commitRemote({ ...BASE_STATE }, 3, 'enable'),
    (error) => error && error.code === 'plugin_revision_conflict' && error.revision === 9
  );
});

test('commitRemote：Go 不可用（status 0）收敛为 plugin_state_unavailable', async () => {
  const { store } = createStore({
    remoteCommit: async () => ({ ok: false, status: 0, data: null, errorCode: 'go_core_unavailable' })
  });
  await assert.rejects(
    () => store.commitRemote({ ...BASE_STATE }, 3, 'enable'),
    (error) => error && error.code === 'plugin_state_unavailable'
  );
});
