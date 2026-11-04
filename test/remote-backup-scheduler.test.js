'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createRemoteBackupScheduler,
  dueTargetIds
} = require('../lib/account/backup/remote-backup-scheduler');
const { writeBackupConfig } = require('../lib/account/backup/remote-backup-config');

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-backup-scheduler-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function target(id, overrides = {}) {
  return {
    id,
    strategy: 'ssh',
    enabled: true,
    host: 'host',
    port: 22,
    username: 'u',
    remoteDir: '~/.aih-backup',
    identityFile: '',
    passwordEnv: '',
    hostKeyFingerprint: '',
    ...overrides
  };
}

function config(targets) {
  return { version: 1, enabled: true, intervalMinutes: 60, debounceSeconds: 0, targets };
}

test('dueTargetIds: never-run and overdue targets are due; recent success and recent failure are not', () => {
  const now = Date.parse('2026-11-04T12:00:00.000Z');
  const cfg = config([target('a'), target('b'), target('c'), target('d', { enabled: false })]);
  const state = {
    version: 1,
    targets: {
      a: { lastOkAt: '2026-11-04T11:30:00.000Z', lastRunAt: '2026-11-04T11:30:00.000Z' },
      b: { lastOkAt: '2026-11-04T10:00:00.000Z', lastRunAt: '2026-11-04T10:00:00.000Z' },
      c: { lastRunAt: '2026-11-04T11:58:00.000Z', lastError: 'ssh_connection_refused' }
    }
  };
  assert.deepEqual(dueTargetIds(cfg, state, now), ['b']);
  // 失败后 5 分钟才重试。
  const later = now + 6 * 60 * 1000;
  assert.deepEqual(dueTargetIds(cfg, state, later), ['b', 'c']);
});

test('scheduler trigger debounces and runs all enabled targets', async (t) => {
  const dir = home(t);
  writeBackupConfig({ fs, aiHomeDir: dir, config: config([target('a'), target('b')]) });
  const calls = [];
  const scheduler = createRemoteBackupScheduler({
    fs,
    aiHomeDir: dir,
    logger: { info() {}, warn() {} },
    runBackup: async (options) => {
      calls.push(options);
      return { ok: true, targets: [] };
    }
  });
  assert.equal(scheduler.trigger('test'), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].targetIds, []);
  assert.equal(calls[0].config.targets.length, 2);
  scheduler.stop();
});

test('scheduler is a no-op when disabled or when there are no targets', async (t) => {
  const dir = home(t);
  writeBackupConfig({ fs, aiHomeDir: dir, config: { ...config([]), enabled: false } });
  const calls = [];
  const scheduler = createRemoteBackupScheduler({
    fs,
    aiHomeDir: dir,
    logger: { info() {}, warn() {} },
    runBackup: async (options) => { calls.push(options); return { ok: true }; }
  });
  assert.equal(scheduler.trigger('test'), false);
  await scheduler.runNow();
  assert.equal(calls.length, 0);
  scheduler.stop();
});

test('scheduler stop prevents later triggers', async (t) => {
  const dir = home(t);
  writeBackupConfig({ fs, aiHomeDir: dir, config: config([target('a')]) });
  const calls = [];
  const scheduler = createRemoteBackupScheduler({
    fs,
    aiHomeDir: dir,
    logger: { info() {}, warn() {} },
    runBackup: async () => { calls.push(1); return { ok: true }; }
  });
  scheduler.stop();
  assert.equal(scheduler.trigger('test'), false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls.length, 0);
});
