'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('node:path');

const { createWebUiTaskHub } = require('../lib/server/webui-task-hub');
const { createClientTerminalJobManager } = require('../lib/server/client-terminal-job-manager');

function fakeFs(paths = []) {
  const existing = new Set(paths);
  return { existsSync: (value) => existing.has(String(value)) };
}

function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('condition_timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('共享 WebUI task hub 合并独立来源并只投影活动任务', () => {
  const hub = createWebUiTaskHub();
  hub.registerSource('apps', () => [{ id: 'app-1', status: 'running', createdAt: 1 }]);
  hub.registerSource('terminals', () => [{ id: 'terminal-1', status: 'queued', createdAt: 2 }]);
  assert.deepEqual(hub.listActiveTasks().map((task) => task.id), ['app-1', 'terminal-1']);
  hub.registerSource('apps', () => [{ id: 'app-1', status: 'succeeded', createdAt: 1 }]);
  assert.deepEqual(hub.listActiveTasks().map((task) => task.id), ['terminal-1']);
});

test('终端安装任务通过 install/update/uninstall 生命周期异步执行并发布状态', async () => {
  const events = [];
  const hub = createWebUiTaskHub();
  const manager = createClientTerminalJobManager({
    taskHub: hub,
    platform: 'macos',
    path: nodePath.posix,
    env: { PATH: '/opt/homebrew/bin' },
    fs: fakeFs(['/opt/homebrew/bin/brew']),
    runPlan: async (plan) => {
      events.push(plan);
      return { ok: true };
    }
  });
  const started = manager.start({ terminalId: 'wezterm', action: 'install', confirmed: true });
  assert.equal(started.ok, true);
  assert.equal(started.job.status, 'queued');
  assert.equal(started.job.source, 'terminal');
  await waitFor(() => manager.getJob(started.job.id)?.status === 'succeeded');
  assert.equal(events[0].args[0], 'install');
  assert.equal(hub.listActiveTasks().length, 0);
});

test('终端更新任务返回真实活动状态并阻止同一目标重复提交，完成后可继续卸载', async () => {
  const changed = [];
  const calls = [];
  let release;
  const hub = createWebUiTaskHub();
  const manager = createClientTerminalJobManager({
    taskHub: hub,
    platform: 'macos',
    path: nodePath.posix,
    env: { PATH: '/opt/homebrew/bin' },
    fs: fakeFs(['/opt/homebrew/bin/brew', '/opt/homebrew/bin/wezterm']),
    onJobChanged: (job) => changed.push(job),
    runPlan: async (plan) => {
      calls.push(plan);
      await new Promise((resolve) => { release = resolve; });
      return { ok: true };
    }
  });

  const updated = manager.start({ terminalId: 'wezterm', action: 'update', confirmed: true });
  assert.equal(updated.ok, true);
  assert.equal(updated.job.status, 'queued');
  const duplicate = manager.start({ terminalId: 'wezterm', action: 'update', confirmed: true });
  assert.equal(duplicate.alreadyRunning, true);
  assert.equal(duplicate.job.id, updated.job.id);
  await waitFor(() => changed.some((job) => job.id === updated.job.id && job.status === 'running'));
  assert.equal(hub.listActiveTasks()[0].action, 'update');
  release();
  await waitFor(() => manager.getJob(updated.job.id)?.status === 'succeeded');
  assert.equal(calls[0].args[0], 'upgrade');

  const uninstalled = manager.start({ terminalId: 'wezterm', action: 'uninstall', confirmed: true });
  assert.equal(uninstalled.ok, true);
  assert.equal(uninstalled.job.action, 'uninstall');
  await waitFor(() => calls.length === 2);
  release();
  await waitFor(() => manager.getJob(uninstalled.job.id)?.status === 'succeeded');
  assert.equal(calls[1].args[0], 'uninstall');
});
