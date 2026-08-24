import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canRetryAppInstallTask,
  canRetryWebUiTask,
  formatAppActionPlan,
  getAppInstallFailureReasons,
  getAppInstallStatusPresentation,
  getAppUpdateActionPresentation,
  getWebUiTaskSourceLabel,
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

test('应用更新检查只在确认已是最新版时停止，其余状态继续提供更新计划', () => {
  assert.deepEqual(getAppUpdateActionPresentation('Codex', {
    ok: true,
    appId: 'codex',
    provider: 'codex',
    currentVersion: '1.2.0',
    latestVersion: '1.2.0',
    updateAvailable: false,
    status: 'current'
  }), {
    shouldExecute: false,
    title: '',
    summary: '',
    notice: 'Codex 已是最新版（1.2.0）',
    metadata: []
  });

  const unavailable = getAppUpdateActionPresentation('Kimi Desktop', {
    ok: false,
    appId: 'kimi-desktop',
    provider: 'kimi',
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    status: 'unavailable'
  });
  assert.equal(unavailable.shouldExecute, true);
  assert.equal(unavailable.title, '更新 Kimi Desktop');
  assert.match(unavailable.summary, /仍会执行更新计划/);
  assert.deepEqual(unavailable.metadata, [{ label: '当前版本', value: '未探测到' }]);

  const unknown = getAppUpdateActionPresentation('Warp', {
    ok: true,
    appId: 'warp',
    provider: 'warp',
    currentVersion: null,
    latestVersion: '0.2026.08.23',
    updateAvailable: false,
    status: 'unknown'
  });
  assert.equal(unknown.shouldExecute, true);
  assert.match(unknown.summary, /无法自动比较/);
  assert.deepEqual(unknown.metadata, [
    { label: '当前版本', value: '未探测到' },
    { label: '远端最新版', value: '0.2026.08.23' }
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

test('后台任务来源区分应用、终端和运行环境', () => {
  assert.equal(getWebUiTaskSourceLabel(makeTask({ source: 'app-install' })), '应用');
  assert.equal(getWebUiTaskSourceLabel(makeTask({ source: 'terminal' })), '终端');
  assert.equal(getWebUiTaskSourceLabel(makeTask({ source: 'environment' })), '运行环境');
  assert.equal(getWebUiTaskSourceLabel(makeTask({ source: 'managed-tool' })), '网络接入');
});

test('统一后台任务允许失败的网络工具重新进入对应生命周期队列', () => {
  const failedTool = makeTask({
    source: 'managed-tool',
    kind: 'managed-tool',
    appId: 'frpc',
    provider: 'frpc',
    action: 'update',
    status: 'failed'
  });
  assert.equal(canRetryWebUiTask(failedTool), true);
  assert.equal(canRetryWebUiTask({ ...failedTool, status: 'succeeded' }), false);
  assert.equal(canRetryAppInstallTask(failedTool), false);
});
