import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canRetryAppInstallTask,
  formatAppActionPlan,
  getAppInstallFailureReasons,
  getAppInstallStatusPresentation,
  mergeWebUiTaskQueueEntries
} from './app-install-presentation.ts';

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    source: 'app-install',
    taskName: 'Kimi Desktop 安装',
    appId: 'kimi-desktop',
    provider: 'kimi',
    kind: 'desktop',
    action: 'install',
    status: 'running',
    phase: 'installing',
    progress: { percent: 40, label: '正在安装' },
    attempts: [],
    createdAt: 100,
    updatedAt: 200,
    ...overrides
  } as any;
}

test('formatAppActionPlan 将命令参数分行并对含空格参数进行 shell 引用', () => {
  assert.equal(
    formatAppActionPlan({
      id: 'kimi-desktop',
      label: 'Kimi 官方安装器',
      command: 'bash',
      args: ['-lc', 'echo hello world']
    }),
    "bash \\\n  -lc \\\n  'echo hello world'"
  );
});

test('getAppInstallFailureReasons 聚合任务与失败步骤原因并去重', () => {
  const task = makeTask({
    status: 'failed',
    error: '安装验证失败',
    attempts: [
      { id: 'download', label: '下载', ok: false, error: '安装验证失败' },
      { id: 'verify', label: '验证应用', ok: false, error: 'Kimi.app not found' },
      { id: 'cleanup', label: '清理', ok: true }
    ]
  });

  assert.deepEqual(getAppInstallFailureReasons(task), [
    '安装验证失败',
    '验证应用：Kimi.app not found'
  ]);
});

test('mergeWebUiTaskQueueEntries 合并活动与最近终态并以活动快照覆盖同 id 旧状态', () => {
  const recentSucceeded = makeTask({ id: 'job-1', status: 'succeeded', updatedAt: 150 });
  const activeRunning = makeTask({ id: 'job-1', status: 'running', updatedAt: 200 });
  const recentFailed = makeTask({ id: 'job-2', status: 'failed', createdAt: 300, updatedAt: 400 });

  const merged = mergeWebUiTaskQueueEntries(
    [activeRunning],
    [recentSucceeded, recentFailed],
    new Set(['job-2'])
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'job-1');
  assert.equal(merged[0].status, 'running');
});

test('终态展示区分成功失败取消，且只有失败的应用任务可重试', () => {
  assert.deepEqual(getAppInstallStatusPresentation('succeeded'), {
    label: '已成功',
    tone: 'success',
    terminal: true
  });
  assert.deepEqual(getAppInstallStatusPresentation('failed'), {
    label: '执行失败',
    tone: 'error',
    terminal: true
  });
  assert.deepEqual(getAppInstallStatusPresentation('cancelled'), {
    label: '已取消',
    tone: 'neutral',
    terminal: true
  });
  assert.equal(canRetryAppInstallTask(makeTask({ status: 'failed' })), true);
  assert.equal(canRetryAppInstallTask(makeTask({ status: 'succeeded' })), false);
  assert.equal(canRetryAppInstallTask(makeTask({ status: 'failed', source: 'terminal' })), false);
});
