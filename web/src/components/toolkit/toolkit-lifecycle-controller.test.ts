import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import type { WebUiTask } from '@/types';

type LifecycleControllerModule = {
  clearCompletedLifecyclePending?: (
    pending: Record<string, { phase: 'planning' | 'submitted'; jobId?: string }>,
    task: WebUiTask,
    source: string
  ) => Record<string, { phase: 'planning' | 'submitted'; jobId?: string }>;
  lifecycleActionKey?: (resourceId: string, action: string) => string;
  taskTargetsLifecycleResource?: (
    task: WebUiTask,
    source: string,
    resourceIds: string[]
  ) => boolean;
};

let controller: LifecycleControllerModule = {};
try {
  controller = await import('./toolkit-lifecycle-controller.ts');
} catch (_error) {}

function read(relativePath: string) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function task(overrides: Partial<WebUiTask> = {}): WebUiTask {
  return {
    id: 'job-frpc-install',
    source: 'managed-tool',
    taskName: '安装 frpc',
    appId: 'frpc',
    provider: 'frpc',
    kind: 'managed-tool',
    action: 'install',
    status: 'succeeded',
    phase: 'completed',
    progress: { percent: 100, label: '完成' },
    attempts: [],
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  };
}

test('生命周期控制器按资源、动作和任务来源维护同一状态键', () => {
  assert.equal(typeof controller.lifecycleActionKey, 'function');
  assert.equal(typeof controller.taskTargetsLifecycleResource, 'function');
  assert.equal(controller.lifecycleActionKey?.('frpc', 'install'), 'frpc:install');
  assert.equal(
    controller.taskTargetsLifecycleResource?.(task(), 'managed-tool', ['frpc']),
    true
  );
  assert.equal(
    controller.taskTargetsLifecycleResource?.(task(), 'environment', ['frpc']),
    false
  );
  assert.equal(
    controller.taskTargetsLifecycleResource?.(
      task({ appId: 'codex-cli', provider: 'codex' }),
      'app-install',
      ['codex-cli', 'codex']
    ),
    false
  );
});

test('任务完成只清理对应资源或 job 的待处理状态', () => {
  assert.equal(typeof controller.clearCompletedLifecyclePending, 'function');
  const pending = {
    'frpc:install': { phase: 'submitted' as const, jobId: 'job-frpc-install' },
    'tmux:update': { phase: 'submitted' as const, jobId: 'job-tmux-update' },
    'herdr:uninstall': { phase: 'planning' as const }
  };
  assert.deepEqual(
    controller.clearCompletedLifecyclePending?.(pending, task(), 'managed-tool'),
    {
      'tmux:update': pending['tmux:update'],
      'herdr:uninstall': pending['herdr:uninstall']
    }
  );
  assert.equal(
    controller.clearCompletedLifecyclePending?.(pending, task(), 'environment'),
    pending
  );
});

test('五类资源共用计划确认执行状态回流控制器', () => {
  const panels = [
    read('./AppManagerPanel.tsx'),
    read('./TerminalManagerPanel.tsx'),
    read('./EnvironmentPanel.tsx'),
    read('./ManagedToolsPanel.tsx')
  ];
  for (const source of panels) {
    assert.match(source, /useToolkitLifecycleController/);
    assert.doesNotMatch(source, /Modal\.confirm/);
  }

  const toolkit = read('../../pages/Toolkit.tsx');
  assert.match(toolkit, /<ManagedToolsPanel category="session-runtimes"/);
  assert.match(toolkit, /<ManagedToolsPanel category="network-access"/);
});

test('平台不适用资源由后端过滤，网络工具界面不再读取 supported 标签', () => {
  assert.doesNotMatch(read('./ManagedToolsPanel.tsx'), /tool\.supported/);
  const types = read('../../types/index.ts');
  const managedToolType = types.slice(
    types.indexOf('export interface ManagedToolItem'),
    types.indexOf('export interface ManagedToolsResponse')
  );
  assert.doesNotMatch(managedToolType, /supported:\s*boolean/);
});
