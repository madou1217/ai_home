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
