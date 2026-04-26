const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSnapshotCacheState,
  ensureSnapshotLoaded,
  commitSnapshot
} = require('../lib/server/webui-snapshot-state');

test('createSnapshotCacheState returns clean default state', () => {
  const state = createSnapshotCacheState();
  assert.deepEqual(state, {
    loadedFromDisk: false,
    refreshTimer: null,
    pendingRefreshTimer: null,
    refreshing: false,
    queued: false,
    dirty: false,
    revision: 0,
    snapshot: [],
    updatedAt: 0,
    lastRefreshAt: 0
  });
});

test('ensureSnapshotLoaded applies persisted revision and only loads once', () => {
  const state = createSnapshotCacheState();
  let reads = 0;
  const loaded = ensureSnapshotLoaded(state, () => {
    reads += 1;
    return {
      revision: 3,
      updatedAt: 123,
      snapshot: [{ id: 'a' }]
    };
  });

  assert.equal(loaded, state);
  assert.equal(state.loadedFromDisk, true);
  assert.equal(state.revision, 3);
  assert.equal(state.updatedAt, 123);
  assert.equal(state.lastRefreshAt, 123);
  assert.deepEqual(state.snapshot, [{ id: 'a' }]);

  ensureSnapshotLoaded(state, () => {
    reads += 1;
    return null;
  });
  assert.equal(reads, 1);
});

test('commitSnapshot updates revision timestamps and persists once', () => {
  const state = createSnapshotCacheState();
  state.dirty = true;
  let persistedRevision = 0;
  const result = commitSnapshot(state, [{ id: 'x' }], (nextState) => {
    persistedRevision = nextState.revision;
  });

  assert.equal(state.revision, 1);
  assert.equal(state.dirty, false);
  assert.deepEqual(state.snapshot, [{ id: 'x' }]);
  assert.equal(result.revision, 1);
  assert.ok(result.updatedAt > 0);
  assert.equal(persistedRevision, 1);
});
