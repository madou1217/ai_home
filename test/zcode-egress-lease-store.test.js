'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ZcodeEgressLeaseStore
} = require('../lib/server/zcode-egress-lease-store');

function createStore(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-leases-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new ZcodeEgressLeaseStore({
    filePath: path.join(root, 'leases.json'),
    now: options.now,
    isProcessAlive: options.isProcessAlive,
    pendingTtlMs: options.pendingTtlMs || 1000
  });
}

test('租约存储按 owner 原子 upsert，并记录分组轮询位置', (t) => {
  let now = 1000;
  const store = createStore(t, { now: () => now });

  const first = store.acquire({
    ownerId: 'desktop:account-a',
    accountRef: 'acct_a',
    instanceKind: 'desktop',
    groupId: 'group-a',
    nodeId: 'a-1'
  });
  now = 1200;
  const updated = store.acquire({
    ownerId: 'desktop:account-a',
    accountRef: 'acct_a',
    instanceKind: 'desktop',
    groupId: 'group-a',
    nodeId: 'a-2'
  });

  assert.equal(first.acquiredAt, 1000);
  assert.equal(updated.acquiredAt, 1000);
  assert.equal(updated.updatedAt, 1200);
  assert.equal(store.listActive().length, 1);
  assert.equal(store.getByOwner('desktop:account-a').nodeId, 'a-2');
  assert.equal(store.getLastSelectedNodeId('group-a'), 'a-2');
});

test('多个实例的活动租约可供调度器避开重复节点', (t) => {
  const store = createStore(t, { now: () => 2000 });
  store.acquire({
    ownerId: 'desktop:account-a',
    accountRef: 'acct_a',
    instanceKind: 'desktop',
    groupId: 'group-a',
    nodeId: 'a-1'
  });
  store.acquire({
    ownerId: 'desktop:account-b',
    accountRef: 'acct_b',
    instanceKind: 'desktop',
    groupId: 'group-a',
    nodeId: 'a-2'
  });

  assert.deepEqual(
    store.listActive().map((lease) => lease.nodeId).sort(),
    ['a-1', 'a-2']
  );
});

test('待启动租约按 TTL 清理，绑定存活 PID 后不按待启动 TTL 过期', (t) => {
  let now = 3000;
  const alive = new Set([4321]);
  const store = createStore(t, {
    now: () => now,
    pendingTtlMs: 500,
    isProcessAlive: (pid) => alive.has(pid)
  });
  store.acquire({
    ownerId: 'desktop:pending',
    accountRef: 'acct_pending',
    instanceKind: 'desktop',
    groupId: 'group-a',
    nodeId: 'a-1'
  });
  store.acquire({
    ownerId: 'desktop:running',
    accountRef: 'acct_running',
    instanceKind: 'desktop',
    groupId: 'group-a',
    nodeId: 'a-2'
  });
  store.attachProcess('desktop:running', 4321);

  now = 4000;
  assert.deepEqual(store.listActive().map((lease) => lease.ownerId), ['desktop:running']);

  alive.delete(4321);
  assert.deepEqual(store.listActive(), []);
});

test('关闭实例可按 owner 或账号释放租约', (t) => {
  const store = createStore(t, { now: () => 5000 });
  for (const [ownerId, accountRef, nodeId] of [
    ['desktop:account-a', 'acct_a', 'a-1'],
    ['cli:account-a:1', 'acct_a', 'a-2'],
    ['desktop:account-b', 'acct_b', 'a-3']
  ]) {
    store.acquire({ ownerId, accountRef, instanceKind: ownerId.startsWith('cli:') ? 'cli' : 'desktop', nodeId });
  }

  assert.equal(store.release('desktop:account-a'), true);
  assert.equal(store.releaseByAccount('acct_a'), 1);
  assert.deepEqual(store.listActive().map((lease) => lease.ownerId), ['desktop:account-b']);
});

test('租约输入缺少身份或节点时拒绝写入', (t) => {
  const store = createStore(t);

  assert.throws(() => store.acquire({ ownerId: '', nodeId: 'a-1' }), /invalid_zcode_egress_lease/);
  assert.throws(() => store.acquire({ ownerId: 'desktop:a', nodeId: '' }), /invalid_zcode_egress_lease/);
});
