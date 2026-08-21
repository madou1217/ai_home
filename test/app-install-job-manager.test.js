'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAppInstallJobManager
} = require('../lib/server/app-install-job-manager');

function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('condition_timeout'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('app install job runs asynchronously, deduplicates active targets, and publishes progress', async () => {
  const events = [];
  const manager = createAppInstallJobManager({
    now: (() => {
      let value = 1000;
      return () => ++value;
    })(),
    installCli: async (provider, options) => {
      assert.equal(provider, 'codex');
      options.onPlanStart({ id: 'npm', label: 'npm installer' });
      options.onProgress({ percent: 45, label: '正在安装 Codex CLI' });
      options.onPlanFinish({ id: 'npm', label: 'npm installer', ok: true });
      return { installed: true, cliPath: '/opt/bin/codex', installAttempts: [] };
    },
    onJobChanged(job) {
      events.push({ status: job.status, percent: job.progress.percent, label: job.progress.label });
    }
  });

  const first = manager.start({ provider: 'codex', kind: 'cli' });
  assert.equal(first.ok, true);
  assert.equal(first.accepted, true);
  assert.equal(first.job.status, 'queued');

  const duplicate = manager.start({ provider: 'codex', kind: 'cli' });
  assert.equal(duplicate.alreadyRunning, true);
  assert.equal(duplicate.job.id, first.job.id);

  await waitFor(() => manager.getJob(first.job.id)?.status === 'succeeded');
  const job = manager.getJob(first.job.id);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.progress.percent, 100);
  assert.equal(job.result.cliPath, '/opt/bin/codex');
  assert.ok(events.some((event) => event.status === 'running'));
  assert.ok(events.some((event) => event.percent === 45 && event.label === '正在安装 Codex CLI'));
  assert.ok(events.some((event) => event.status === 'succeeded'));
});

test('app install job is published to the shared Toolkit task hub', async () => {
  const registeredSources = [];
  const published = [];
  const taskHub = {
    registerSource(source, listActiveJobs) {
      registeredSources.push({ source, listActiveJobs });
    },
    publish(task) {
      published.push(task);
    }
  };
  const manager = createAppInstallJobManager({
    taskHub,
    installCli: async () => ({ installed: true, cliPath: '/opt/bin/codex' })
  });

  const started = manager.start({ appId: 'codex' });
  await waitFor(() => manager.getJob(started.job.id)?.status === 'succeeded');

  assert.deepEqual(registeredSources.map((item) => item.source), ['app-install']);
  assert.ok(published.some((task) => task.id === started.job.id && task.source === 'app-install' && task.status === 'queued'));
  assert.ok(published.some((task) => task.id === started.job.id && task.source === 'app-install' && task.status === 'succeeded'));
  assert.deepEqual(registeredSources[0].listActiveJobs(), []);
});

test('app install job exposes failed result without throwing into the HTTP caller', async () => {
  const manager = createAppInstallJobManager({
    installCli: async () => ({ installed: false, installAttempts: [{ ok: false, error: 'permission denied' }] })
  });
  const started = manager.start({ provider: 'qoder', kind: 'cli' });
  await waitFor(() => manager.getJob(started.job.id)?.status === 'failed');
  const job = manager.getJob(started.job.id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /permission denied/);
});

test('desktop install only succeeds after the installed client is rediscovered', async () => {
  const verificationResults = [null, { executablePath: '/Applications/OpenCode.app' }];
  const manager = createAppInstallJobManager({
    resolveDesktopInstallPlans: () => [
      { id: 'official-first', label: 'official first', command: 'installer', args: [] },
      { id: 'official-fallback', label: 'official fallback', command: 'installer', args: [] }
    ],
    runInstallPlan: async () => ({ ok: true, status: 0 }),
    verifyDesktopInstall: async () => verificationResults.shift()
  });

  const started = manager.start({ provider: 'opencode', kind: 'desktop' });
  await waitFor(() => manager.getJob(started.job.id)?.status === 'succeeded');
  const job = manager.getJob(started.job.id);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.result.executablePath, '/Applications/OpenCode.app');
  assert.equal(job.attempts.length, 2);
  assert.equal(job.attempts[0].ok, false);
  assert.match(job.attempts[0].error, /未检测到目标 Desktop 应用/);
  assert.equal(job.attempts[1].ok, true);
});

test('Kimi macOS Desktop 通过统一异步任务执行官方安装计划并回流可执行路径', async () => {
  const executedPlans = [];
  const manager = createAppInstallJobManager({
    processObj: { platform: 'darwin', arch: 'arm64', env: {} },
    runInstallPlan: async (plan) => {
      executedPlans.push(plan);
      return { ok: true, status: 0 };
    },
    verifyDesktopInstall: async (provider) => {
      assert.equal(provider, 'kimi');
      return {
        executablePath: '/Users/test/Applications/Kimi.app/Contents/MacOS/Kimi'
      };
    }
  });

  const started = manager.start({ provider: 'kimi', kind: 'desktop' });
  assert.equal(started.ok, true);
  await waitFor(() => manager.getJob(started.job.id)?.status === 'succeeded');

  const job = manager.getJob(started.job.id);
  assert.equal(executedPlans.length, 1);
  assert.equal(executedPlans[0].id, 'kimi_desktop_macos_official');
  assert.equal(job.result.executablePath, '/Users/test/Applications/Kimi.app/Contents/MacOS/Kimi');
});

test('ZCode CLI 安装任务在入口处拒绝，避免把 Desktop 误报为 CLI', () => {
  const manager = createAppInstallJobManager();
  assert.equal(manager.canInstall({ provider: 'zcode', kind: 'cli' }), false);
  assert.deepEqual(manager.start({ provider: 'zcode', kind: 'cli' }), {
    ok: false,
    error: 'cli_not_supported'
  });
});

test('独立托管 CLI 支持更新和卸载生命周期，任务中保留 action', async () => {
  const commands = [];
  const manager = createAppInstallJobManager({
    runInstallPlan: async (plan) => {
      commands.push(plan.id);
      return { ok: true, status: 0 };
    },
    processObj: { platform: 'darwin', env: { PATH: '' }, cwd: () => process.cwd() },
    hostHomeDir: '/tmp/aih-test-dsh'
  });

  for (const action of ['update', 'uninstall']) {
    const started = manager.start({ appId: 'dsh', action });
    assert.equal(started.ok, true);
    assert.equal(started.job.action, action);
    await waitFor(() => manager.getJob(started.job.id)?.status === 'succeeded');
  }
  assert.deepEqual(commands, ['npm_global_update', 'npm_global_uninstall']);
});
