'use strict';

// 删除账号的桌面进程占用探针（zcode / kimi）。
//
// 全部用假扫描表与假进程表驱动：真机上这些测试不应该依赖真的开着哪个桌面窗口，
// 也不能在跑测试时误杀用户进程。唯一验证的边界是「归属」与「release 语义」。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  detectDeletionBlockers,
  releaseDeletionBlockers
} = require('../lib/server/account-deletion-occupancy');
const { buildZcodeDesktopApplicationName } = require('../lib/runtime/account-app-process-marker');

const AI_HOME = '/tmp/aih-occupancy-test';
const OWN_REF = 'acct_0123456789abcdef0123';
const OTHER_REF = 'acct_fedcba9876543210fedc';
const PROFILE_ROOT = path.join(AI_HOME, 'profiles');

function profileDirFor(provider, accountRef) {
  return path.join(PROFILE_ROOT, provider, accountRef);
}

function makeCtx(overrides = {}) {
  return {
    // 不注入 aiHomeDir 时持久会话描述符直接跳过；桌面探针也不读注册表。
    getProfileDir: profileDirFor,
    fs: {
      readdirSync() {
        const error = new Error('ENOENT: no such file or directory');
        error.code = 'ENOENT';
        throw error;
      },
      readFileSync() {
        const error = new Error('ENOENT: no such file or directory');
        error.code = 'ENOENT';
        throw error;
      }
    },
    ...overrides
  };
}

function zcodeTarget(accountRef = OWN_REF) {
  return { provider: 'zcode', accountRef };
}

test('zcode 本账号的 ZCode-<hash> 主进程 → blocked', async () => {
  const ctx = makeCtx({
    listDesktopInstances: () => [{
      pid: 4242,
      applicationName: buildZcodeDesktopApplicationName(OWN_REF)
    }]
  });
  const result = await detectDeletionBlockers(ctx, zcodeTarget());
  assert.equal(result.blocked, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, 'desktop_app');
  assert.equal(result.items[0].pid, 4242);
  assert.equal(result.items[0].accountRef, OWN_REF);
});

test('zcode 他账号的同名进程 → 不 blocked', async () => {
  const ctx = makeCtx({
    listDesktopInstances: () => [
      { pid: 5001, applicationName: buildZcodeDesktopApplicationName(OTHER_REF) },
      { pid: 5002, applicationName: 'ZCode-deadbeef' }
    ]
  });
  const result = await detectDeletionBlockers(ctx, zcodeTarget());
  assert.equal(result.blocked, false);
  assert.deepEqual(result.items, []);
});

test('zcode hosts/<pid>.json 的 accountRef 可精确归属（且 pid 必须存活）', async () => {
  const hostRows = {
    '6001.json': { pid: 6001, ready: true, at: Date.now(), accountRef: OWN_REF }
  };
  let alive = true;
  const ctx = makeCtx({
    isProcessAlive: () => alive,
    zcodeMailboxDir: '/tmp/aih-occupancy-mailbox',
    fs: {
      readdirSync: () => Object.keys(hostRows),
      readFileSync: (file) => JSON.stringify(hostRows[path.basename(file)])
    },
    // 标题里的 hash 既不是本账号也不是已知账号，只能靠 mailbox 认领。
    listDesktopInstances: () => [{ pid: 6001, applicationName: 'ZCode-0badc0de' }]
  });
  const blocked = await detectDeletionBlockers(ctx, zcodeTarget());
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.items[0].pid, 6001);

  // 进程已退出时，残留的 ready row 不再算数。
  alive = false;
  const afterExit = await detectDeletionBlockers(ctx, zcodeTarget());
  assert.equal(afterExit.blocked, false);
});

test('zcode mailbox 里过期的残留 row 不算占用', async () => {
  const ctx = makeCtx({
    isProcessAlive: () => true,
    zcodeMailboxDir: '/tmp/aih-occupancy-mailbox',
    fs: {
      readdirSync: () => ['6002.json'],
      readFileSync: () => JSON.stringify({
        pid: 6002, ready: true, at: Date.now() - 20000, accountRef: OWN_REF
      })
    },
    listDesktopInstances: () => [{ pid: 6002, applicationName: 'ZCode-0badc0de' }]
  });
  const result = await detectDeletionBlockers(ctx, zcodeTarget());
  assert.equal(result.blocked, false);
});

test('kimi 按 --user-data-dir 归账号，他账号目录不 blocked', async () => {
  const ownDir = path.join(profileDirFor('kimi', OWN_REF), 'electron-user-data');
  const otherDir = path.join(profileDirFor('kimi', OTHER_REF), 'electron-user-data');
  const ctx = makeCtx({
    listDesktopInstances: () => [
      { pid: 7001, userDataDir: ownDir },
      { pid: 7002, userDataDir: otherDir },
      { pid: 7003, userDataDir: path.join(PROFILE_ROOT, 'kimi', OWN_REF, 'daimon-bundle') }
    ]
  });
  const result = await detectDeletionBlockers(ctx, { provider: 'kimi', accountRef: OWN_REF });
  assert.equal(result.blocked, true);
  assert.deepEqual(result.items.map((item) => item.pid), [7001]);
});

test('扫描抛错 → desktop_app uncertain + blocked（不降级为空）', async () => {
  const ctx = makeCtx({
    listDesktopInstances: () => { throw new Error('ps failed'); }
  });
  const result = await detectDeletionBlockers(ctx, zcodeTarget());
  assert.equal(result.blocked, true);
  const item = result.items.find((entry) => entry.kind === 'desktop_app');
  assert.ok(item, 'desktop_app 必须产出一条占用项');
  assert.equal(item.uncertain, true);
  assert.match(item.detail, /ps failed/);
});

test('release 只结束本账号主进程，复探为空才算成功', async () => {
  let instances = [
    { pid: 8001, applicationName: buildZcodeDesktopApplicationName(OWN_REF) },
    { pid: 8002, applicationName: buildZcodeDesktopApplicationName(OTHER_REF) }
  ];
  const alive = new Set([8001, 8002]);
  const killed = [];
  const ctx = makeCtx({
    listDesktopInstances: () => instances,
    isProcessAlive: (pid) => alive.has(pid),
    sleep: async () => {},
    processObj: {
      kill(pid) {
        killed.push(pid);
        alive.delete(pid);
        instances = instances.filter((instance) => instance.pid !== pid);
      }
    }
  });
  const detected = await detectDeletionBlockers(ctx, zcodeTarget());
  assert.deepEqual(detected.items.map((item) => item.pid), [8001]);

  const release = await releaseDeletionBlockers(ctx, detected.items);
  assert.equal(release.released, true);
  assert.deepEqual(killed, [8001]);

  const after = await detectDeletionBlockers(ctx, zcodeTarget());
  assert.equal(after.blocked, false);
});

test('release 后复探仍阻塞 → released:false', async () => {
  const ctx = makeCtx({
    listDesktopInstances: () => [{ pid: 8101, applicationName: buildZcodeDesktopApplicationName(OWN_REF) }],
    isProcessAlive: () => true,
    sleep: async () => {},
    processObj: { kill() {} }
  });
  const detected = await detectDeletionBlockers(ctx, zcodeTarget());
  const release = await releaseDeletionBlockers(ctx, detected.items);
  assert.equal(release.released, false);
  assert.equal(release.failed.length, 1);
  assert.equal(release.failed[0].reason, 'desktop_app_still_running');
});

test('release 遇到 uncertain 项不杀进程', async () => {
  let killed = 0;
  const ctx = makeCtx({
    processObj: { kill() { killed += 1; } }
  });
  const release = await releaseDeletionBlockers(ctx, [{
    kind: 'desktop_app', label: '运行中的桌面应用', uncertain: true, pid: 9001
  }]);
  assert.equal(release.released, false);
  assert.equal(release.failed[0].reason, 'desktop_app_state_unknown');
  assert.equal(killed, 0);
});

