'use strict';

// 运行期目录保留策略（`~/.ai_home/run` 下的可再生运行态）。
// 守三件事：删除账号的 harness 立即回收、超期登录沙箱回收、当前进程 HOME 永不回收。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_RETENTION_DAYS,
  resolveRetentionDays,
  sweepRuntimeRetention
} = require('../lib/runtime/runtime-retention');

const DAY = 24 * 60 * 60 * 1000;

function withAihHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, 'aih');
  fs.mkdirSync(path.join(aiHomeDir, 'run'), { recursive: true });
  return { root, aiHomeDir };
}

function makeDir(dirPath, { ageDays = 0, bytes = 16 } = {}) {
  fs.mkdirSync(dirPath, { recursive: true });
  const file = path.join(dirPath, 'data.bin');
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  // 目录和里面的文件一起做旧：判定看的是「目录树里最新一次写入」，只改目录 mtime 等于没做旧。
  const stamp = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(file, stamp, stamp);
  fs.utimesSync(dirPath, stamp, stamp);
  return dirPath;
}

test('保留期默认 10 天，可用环境变量覆盖', () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 10);
  assert.equal(resolveRetentionDays({}), 10);
  assert.equal(resolveRetentionDays({ AIH_RUNTIME_RETENTION_DAYS: '3' }), 3);
  assert.equal(resolveRetentionDays({ AIH_RUNTIME_RETENTION_DAYS: 'x' }), 10);
});

test('删除账号的 harness 立即回收，现存账号保留', (t) => {
  const { aiHomeDir } = withAihHome(t);
  const harness = path.join(aiHomeDir, 'run', 'chat-harness');
  const orphan = makeDir(path.join(harness, 'acct_gone'));
  const active = makeDir(path.join(harness, 'acct_alive'));

  const report = sweepRuntimeRetention({ fs, path, aiHomeDir, activeAccountRefs: ['acct_alive'] });
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(fs.existsSync(active), true);
  assert.equal(report.removed.length, 1);
  assert.equal(report.removed[0].reason, 'orphan-harness');
  assert.ok(report.freedBytes >= 16);
});

test('超期 login 沙箱回收，当前 HOME 受保护', (t) => {
  const { aiHomeDir } = withAihHome(t);
  const loginRoot = path.join(aiHomeDir, 'run', 'login', 'codebuddy');
  const stale = makeDir(path.join(loginRoot, 'auth-old'), { ageDays: 12 });
  const recent = makeDir(path.join(loginRoot, 'auth-new'), { ageDays: 1 });
  const current = makeDir(path.join(loginRoot, 'auth-current'), { ageDays: 30 });

  const report = sweepRuntimeRetention({ fs, path, aiHomeDir, currentHome: current, keepDays: 10 });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(current), true);
  assert.deepEqual(report.removed.map((item) => item.reason), ['stale-login']);
});

test('超期 verification 回收，未超期保留', (t) => {
  const { aiHomeDir } = withAihHome(t);
  const verification = path.join(aiHomeDir, 'run', 'verification');
  const oldDir = makeDir(path.join(verification, 'account-refresh-20261007'), { ageDays: 25 });
  const fresh = makeDir(path.join(verification, 'recent'), { ageDays: 2 });

  const report = sweepRuntimeRetention({ fs, path, aiHomeDir, keepDays: 10 });
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(report.removed.length, 1);
});

test('没有账号列表时不做孤儿回收', (t) => {
  const { aiHomeDir } = withAihHome(t);
  const harness = path.join(aiHomeDir, 'run', 'chat-harness');
  const dir = makeDir(path.join(harness, 'acct_gone'));
  sweepRuntimeRetention({ fs, path, aiHomeDir });
  assert.equal(fs.existsSync(dir), true);
});

test('顶层目录 mtime 很旧但内部还在写：不当作超期（活跃 harness 不能误杀）', (t) => {
  const { aiHomeDir } = withAihHome(t);
  const harness = path.join(aiHomeDir, 'run', 'chat-harness');
  const dir = path.join(harness, 'acct_live');
  // 先造内部结构（.codex 天天在写），再把顶层目录做旧——真实形态就是这样：
  // mkdir 会刷新父目录 mtime，而日常写 .codex/** 不会。
  const inner = path.join(dir, '.codex', 'sessions');
  fs.mkdirSync(inner, { recursive: true });
  const activeFile = path.join(inner, 'rollout.jsonl');
  fs.writeFileSync(activeFile, 'x');
  const oldStamp = new Date(Date.now() - 20 * DAY);
  fs.utimesSync(dir, oldStamp, oldStamp);

  const report = sweepRuntimeRetention({ fs, path, aiHomeDir, activeAccountRefs: ['acct_live'], keepDays: 10 });
  assert.equal(fs.existsSync(dir), true);
  assert.equal(report.removed.length, 0);
});

test('私有 thread store 的 harness 超期也不回收（thread 只在这里）', (t) => {
  const { aiHomeDir, root } = withAihHome(t);
  const harness = path.join(aiHomeDir, 'run', 'chat-harness');
  const privateHome = makeDir(path.join(harness, 'acct_private'), { ageDays: 30 });
  // 真文件 = 私有 store：这个 harness 里的 thread 不在全局 codex 存储里
  fs.mkdirSync(path.join(privateHome, '.codex'), { recursive: true });
  const storeFile = path.join(privateHome, '.codex', 'thread_history_1.sqlite');
  fs.writeFileSync(storeFile, Buffer.alloc(4096, 1));
  // 建子目录/文件会刷新父目录 mtime，做完结构再整体做旧
  const oldStamp = new Date(Date.now() - 30 * DAY);
  fs.utimesSync(storeFile, oldStamp, oldStamp);
  fs.utimesSync(path.join(privateHome, '.codex'), oldStamp, oldStamp);
  fs.utimesSync(path.join(privateHome, 'data.bin'), oldStamp, oldStamp);
  fs.utimesSync(privateHome, oldStamp, oldStamp);

  const report = sweepRuntimeRetention({
    fs,
    path,
    aiHomeDir,
    activeAccountRefs: ['acct_private'],
    keepDays: 10
  });
  assert.equal(fs.existsSync(privateHome), true);
  assert.equal(report.removed.length, 0);
});

test('链式 harness（thread store 是软链）超期照常回收：删掉的只是链接', (t) => {
  const { aiHomeDir, root } = withAihHome(t);
  const harness = path.join(aiHomeDir, 'run', 'chat-harness');
  const linkedHome = makeDir(path.join(harness, 'acct_linked'), { ageDays: 30 });
  const sharedStore = path.join(root, 'shared-thread_history_1.sqlite');
  fs.writeFileSync(sharedStore, Buffer.alloc(4096, 1));
  fs.mkdirSync(path.join(linkedHome, '.codex'), { recursive: true });
  fs.symlinkSync(sharedStore, path.join(linkedHome, '.codex', 'thread_history_1.sqlite'));
  // 建子目录/软链会刷新父目录 mtime，做完结构再整体做旧
  const oldStamp = new Date(Date.now() - 30 * DAY);
  fs.utimesSync(path.join(linkedHome, '.codex'), oldStamp, oldStamp);
  fs.utimesSync(linkedHome, oldStamp, oldStamp);
  fs.utimesSync(path.join(linkedHome, 'data.bin'), oldStamp, oldStamp);

  const report = sweepRuntimeRetention({
    fs,
    path,
    aiHomeDir,
    activeAccountRefs: ['acct_linked'],
    keepDays: 10
  });
  assert.equal(fs.existsSync(linkedHome), false);
  assert.equal(report.removed[0].reason, 'stale-harness');
  // 共享存储本身不能被碰
  assert.equal(fs.existsSync(sharedStore), true);
});

test('账号已删除的 harness 立即回收', (t) => {
  const { aiHomeDir } = withAihHome(t);
  const harness = path.join(aiHomeDir, 'run', 'chat-harness');
  const orphan = makeDir(path.join(harness, 'acct_gone'));

  const report = sweepRuntimeRetention({ fs, path, aiHomeDir, activeAccountRefs: ['acct_alive'], keepDays: 10 });
  assert.equal(fs.existsSync(orphan), false);
  assert.equal(report.removed[0].reason, 'orphan-harness');
});
