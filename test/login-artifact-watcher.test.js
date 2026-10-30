'use strict';

// 回归守卫（2026-10-30 真机）：`aih codebuddy login` 在假 HOME 里登录成功后，
// CLI 把凭据写进 CodeBuddyExtension 的 .info 文件，**然后直接进 TUI**，进程不退出。
// aih 的入库只挂在 onExit(exitCode===0) 上，于是「浏览器显示登录成功，账号却没留存」。
// 修法：登录期轮询凭据产物（连续两次命中才算写完），命中后主动收尾。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLoginArtifactWatcher } = require('../lib/cli/services/pty/login-artifact-watcher');
const { hasOauthCompletionArtifacts } = require('../lib/server/web-account-auth-oauth-tokens');

function createManualTimers() {
  let handler = null;
  return {
    setIntervalImpl: (fn) => { handler = fn; return { unref() {} }; },
    clearIntervalImpl: () => { handler = null; },
    fire: () => { if (handler) handler(); },
    get active() { return handler !== null; }
  };
}

test('连续两次命中才算写完：第一次命中不触发收尾', () => {
  const timers = createManualTimers();
  let done = 0;
  const watcher = createLoginArtifactWatcher({
    probe: () => true,
    onComplete: () => { done += 1; },
    stableTicks: 2,
    ...timers
  });
  timers.fire();
  assert.equal(done, 0);
  timers.fire();
  assert.equal(done, 1);
  assert.equal(watcher.running, false);
});

test('中途断掉会重置连续计数（避免读到写了一半的文件）', () => {
  const timers = createManualTimers();
  let done = 0;
  const answers = [true, false, true, true];
  let index = 0;
  createLoginArtifactWatcher({
    probe: () => answers[index++],
    onComplete: () => { done += 1; },
    stableTicks: 2,
    ...timers
  });
  timers.fire();
  timers.fire();
  timers.fire();
  assert.equal(done, 0);
  timers.fire();
  assert.equal(done, 1);
});

test('超时后静默停手，不会无限轮询', () => {
  const timers = createManualTimers();
  const watcher = createLoginArtifactWatcher({
    probe: () => false,
    maxAttempts: 3,
    ...timers
  });
  timers.fire();
  timers.fire();
  timers.fire();
  assert.equal(watcher.running, false);
  assert.equal(watcher.attempts, 3);
});

test('stop() 之后不再探测', () => {
  const timers = createManualTimers();
  let probes = 0;
  const watcher = createLoginArtifactWatcher({
    probe: () => { probes += 1; return false; },
    ...timers
  });
  watcher.stop();
  timers.fire();
  assert.equal(probes, 0);
});

test('probe 抛错时走 onError 并停手', () => {
  const timers = createManualTimers();
  let errors = 0;
  const watcher = createLoginArtifactWatcher({
    probe: () => { throw new Error('boom'); },
    onError: () => { errors += 1; },
    ...timers
  });
  timers.fire();
  assert.equal(errors, 1);
  assert.equal(watcher.running, false);
});

test('codebuddy 作业布局：凭据文件落地即判定登录完成', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-cb-watch-'));
  try {
    const job = { provider: 'codebuddy', runtimeDir: root, platform: 'darwin' };
    assert.equal(hasOauthCompletionArtifacts(job, fs), false);
    const authDir = path.join(root, 'Library', 'Application Support', 'CodeBuddyExtension',
      'Data', 'Public', 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'Tencent-Cloud.coding-copilot.info'), JSON.stringify({
      account: { uid: 'u-1' },
      auth: { accessToken: 'token' }
    }));
    assert.equal(hasOauthCompletionArtifacts(job, fs), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
