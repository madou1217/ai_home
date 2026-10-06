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

test('持有进程已死的残留锁被立即接管，而不是报 busy 卡死', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-lease-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'leases.json');
  const store = new ZcodeEgressLeaseStore({
    filePath,
    now: () => Date.now(),
    isProcessAlive: () => false,
    lockWaitBudgetMs: 20
  });

  // 模拟持有进程被强杀留下的锁：pid 指向已死进程、内容完整。
  fs.writeFileSync(`${filePath}.lock`, JSON.stringify({ pid: 999999, createdAt: Date.now() }));

  const lease = store.acquire({ ownerId: 'desktop:account-a', accountRef: 'acct_a', nodeId: 'a-1' });
  assert.equal(lease.nodeId, 'a-1', '死锁接管后正常取得租约');
  assert.equal(fs.existsSync(`${filePath}.lock`), false, '临界区结束后锁已释放');
});

test('内容不可读的半截锁被判定为残留并接管', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-lease-partial-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'leases.json');
  const store = new ZcodeEgressLeaseStore({
    filePath,
    now: () => Date.now(),
    isProcessAlive: () => true,
    lockWaitBudgetMs: 20
  });

  fs.writeFileSync(`${filePath}.lock`, '{"pid":123', 'utf8');
  // 内容不可判时回退锁龄（mtime）；新鲜半截锁与 proxy-node-store 语义一致：等待而非抢锁。
  const stale = new Date(Date.now() - 31000);
  fs.utimesSync(`${filePath}.lock`, stale, stale);

  const lease = store.acquire({ ownerId: 'desktop:account-a', accountRef: 'acct_a', nodeId: 'a-2' });
  assert.equal(lease.nodeId, 'a-2', '超龄半截锁按残留处理');
});

test('存活持有者的新鲜锁在预算内快速报 busy，不长期阻塞', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-lease-busy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'leases.json');
  const store = new ZcodeEgressLeaseStore({
    filePath,
    now: () => Date.now(),
    isProcessAlive: () => true,
    lockWaitBudgetMs: 15
  });

  fs.writeFileSync(`${filePath}.lock`, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));

  const startedAt = Date.now();
  assert.throws(() => store.acquire({ ownerId: 'o', accountRef: 'a', nodeId: 'n' }), /zcode_egress_lease_store_busy/);
  assert.ok(Date.now() - startedAt < 1000, `busy 快速失败（实际 ${Date.now() - startedAt}ms）`);
});

test('超过 30s 的锁即使 pid 探活失败被误判存活也会按时效接管', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-lease-aged-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'leases.json');
  const store = new ZcodeEgressLeaseStore({
    filePath,
    now: () => Date.now(),
    isProcessAlive: () => true,
    lockWaitBudgetMs: 20
  });

  fs.writeFileSync(`${filePath}.lock`, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 31000 }));

  const lease = store.acquire({ ownerId: 'o', accountRef: 'a', nodeId: 'n' });
  assert.equal(lease.nodeId, 'n', '超龄锁按时效接管');
});

test('锁文件写入失败时关闭并删除半截锁，不留残留', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-lease-wfail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'leases.json');
  const failingFs = {
    ...fs,
    writeFileSync: (target, ...rest) => {
      // 锁内容按 fd 写入（_acquireLock 里 openSync 'wx' 后 writeFileSync(fd,...)），
      // 数据文件走 atomicWritePrivateFile 的路径写入——按 fd 精确拦截锁写入。
      if (typeof target === 'number') {
        throw new Error('ENOSPC: no space left on device');
      }
      return fs.writeFileSync(target, ...rest);
    }
  };
  const store = new ZcodeEgressLeaseStore({
    filePath,
    fs: failingFs,
    now: () => Date.now(),
    isProcessAlive: () => true,
    lockWaitBudgetMs: 20
  });

  assert.throws(
    () => store.listActive(),
    /zcode_egress_lease_store_busy/
  );
  assert.equal(fs.existsSync(`${filePath}.lock`), false, '写入失败后锁文件已被清理');
});
