import { useCallback, useEffect, useMemo, useState } from 'react';
import { message, Modal } from 'antd';
import { toolkitAPI } from '@/services/api';
import { useWebUiTaskQueue } from '@/services/webui-task-queue';
import type {
  ManagedToolActionResponse,
  ManagedToolItem,
  ManagedToolLifecycleAction,
  ManagedToolsResponse,
  ToolkitToolCategoryId,
  WebUiTask
} from '@/types';
import AppActionConfirmContent from './AppActionConfirmContent';
import {
  isLifecycleAction as isManagedToolAction,
  LIFECYCLE_ACTION_LABELS as ACTION_LABELS,
  LIFECYCLE_ACTIONS as MANAGED_TOOL_ACTIONS
} from './lifecycle-presentation';
import { toolkitRequestError as requestError } from './request-error';

export const MANAGED_TOOL_DISCOVERY_SOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'running-process': '运行进程参数',
  systemd: 'systemd 服务',
  launchd: 'launchd 任务',
  'scheduled-task': 'Windows 计划任务',
  'windows-service': 'Windows 服务',
  'startup-command': '系统启动项',
  environment: '环境变量',
  'working-directory': '工作目录',
  'standard-path': '标准位置'
});

export const MANAGED_TOOL_CAPABILITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  detect: '安装检测',
  version: '版本读取',
  sessions: '会话支持',
  'config-edit': '配置编辑',
  'config-validate': '配置校验'
});

export const MANAGED_TOOL_MANAGEMENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  aih: 'AIH 管理',
  homebrew: 'Homebrew 管理',
  external: '外部安装'
});

export function managedToolRuntimeSummary(tool: ManagedToolItem) {
  if (!tool.runtimeInspectable) return '无需运行时探测';
  if (tool.running) return `运行中${tool.runningCount > 1 ? `（${tool.runningCount} 个）` : ''}`;
  return tool.installed ? '当前未运行' : '未发现程序';
}

export function managedToolConfigSummary(tool: ManagedToolItem) {
  if (tool.configState === 'multiple') return `已发现 ${tool.configCount} 个配置，需先消除歧义`;
  if (tool.configState === 'unresolved') return '运行参数指向的配置当前无法安全读取';
  if (tool.configState === 'token-managed') return '令牌托管模式未使用本地配置文件';
  if (tool.configName) {
    return `${tool.configName} 已发现${tool.configSource ? `（${MANAGED_TOOL_DISCOVERY_SOURCE_LABELS[tool.configSource] || tool.configSource}）` : ''}`;
  }
  return tool.runtimeInspectable ? '未发现实际配置文件' : '无本地配置';
}

type PendingAction = { phase: 'planning' | 'submitted'; jobId?: string };

/** 受管工具生命周期接口：由调用方注入 toolkitAPI 的 plan / execute 两个端点。 */
export interface ManagedToolLifecycleApi {
  plan: (toolId: string, action: ManagedToolLifecycleAction) => Promise<ManagedToolActionResponse>;
  execute: (toolId: string, action: ManagedToolLifecycleAction) => Promise<ManagedToolActionResponse>;
}

function taskTargetsTool(task: WebUiTask, toolId: string) {
  return task.source === 'managed-tool'
    && (task.appId === toolId || task.provider === toolId);
}

function actionKey(tool: ManagedToolItem, action: ManagedToolLifecycleAction) {
  return `${tool.id}:${action}`;
}

/**
 * 受管工具（会话运行时 / 网络接入）的数据层（桌面面板与移动端共用）：
 * 工具探测、生命周期计划确认与后台任务跟踪。配置编辑由界面自行持有。
 */
export function useManagedTools(category: ToolkitToolCategoryId, lifecycleApi: ManagedToolLifecycleApi) {
  const [data, setData] = useState<ManagedToolsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingActions, setPendingActions] = useState<Record<string, PendingAction>>({});
  const { tasks, recentTasks } = useWebUiTaskQueue();

  const fetchTools = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await toolkitAPI.listTools();
      if (!result.ok) throw new Error('工具状态接口未返回可用结果');
      setData(result);
    } catch (error: unknown) {
      setError(requestError(error, '获取工具状态失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTools();
  }, [fetchTools]);

  useEffect(() => {
    const handleTaskCompleted = (event: Event) => {
      const task = (event as CustomEvent<WebUiTask>).detail;
      if (task?.source !== 'managed-tool') return;
      setPendingActions((current) => {
        const next = { ...current };
        Object.entries(current).forEach(([key, pending]) => {
          if (pending.jobId === task.id || key.startsWith(`${task.appId || task.provider}:`)) delete next[key];
        });
        return next;
      });
      void fetchTools();
    };
    window.addEventListener('aih:webui-task-completed', handleTaskCompleted);
    return () => window.removeEventListener('aih:webui-task-completed', handleTaskCompleted);
  }, [fetchTools]);

  useEffect(() => {
    if (!recentTasks.length) return;
    setPendingActions((current) => {
      const next = { ...current };
      let changed = false;
      Object.entries(current).forEach(([key, pending]) => {
        if (!pending.jobId) return;
        const completed = recentTasks.find((task) => task.id === pending.jobId
          && task.source === 'managed-tool'
          && !['queued', 'running'].includes(String(task.status || '').toLowerCase()));
        if (completed) {
          delete next[key];
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [recentTasks]);

  const tools = useMemo(
    () => (data?.tools || []).filter((tool) => tool.category === category),
    [category, data]
  );
  const categoryInfo = data?.categories.find((item) => item.id === category);
  const installedCount = tools.filter((tool) => tool.installed).length;
  const editableCount = tools.filter((tool) => tool.configEditable).length;
  const lifecycleCount = tools.filter((tool) => tool.canInstall || tool.canUpdate || tool.canUninstall).length;
  const managedToolTasks = useMemo(
    () => tasks.filter((task) => task.source === 'managed-tool'),
    [tasks]
  );

  const activeTaskFor = (tool: ManagedToolItem) => managedToolTasks.find(
    (task) => taskTargetsTool(task, tool.id)
  );

  const busyActionFor = (tool: ManagedToolItem) => {
    const pending = MANAGED_TOOL_ACTIONS.find((action) => pendingActions[actionKey(tool, action)]);
    if (pending) return pending;
    const activeAction = activeTaskFor(tool)?.action;
    return isManagedToolAction(activeAction) ? activeAction : undefined;
  };

  const submitAction = async (
    tool: ManagedToolItem,
    action: ManagedToolLifecycleAction,
    key: string
  ) => {
    try {
      const response = await lifecycleApi.execute(tool.id, action);
      if (!response.ok || !response.job) throw new Error(response.error || '网络工具任务未创建');
      setPendingActions((current) => ({
        ...current,
        [key]: { phase: 'submitted', jobId: response.job?.id }
      }));
      message.info(`${tool.name}${ACTION_LABELS[action]}任务已提交`);
    } catch (requestFailure: unknown) {
      setPendingActions((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      message.error(requestError(requestFailure, `${tool.name}${ACTION_LABELS[action]}失败`));
    }
  };

  const runAction = async (tool: ManagedToolItem, action: ManagedToolLifecycleAction) => {
    const key = actionKey(tool, action);
    if (busyActionFor(tool)) return;
    setPendingActions((current) => ({ ...current, [key]: { phase: 'planning' } }));
    try {
      const response = await lifecycleApi.plan(tool.id, action);
      if (!response.ok) throw new Error(response.error || '无法生成网络工具计划');
      Modal.confirm({
        title: `${ACTION_LABELS[action]} ${tool.name}`,
        content: (
          <AppActionConfirmContent
            summary={`确认后将创建 ${tool.name}${ACTION_LABELS[action]}任务，进度显示在后台任务队列。`}
            plans={(response.plans || []).map((plan) => ({
              id: plan.id,
              label: plan.label,
              command: plan.command,
              args: plan.args
            }))}
          />
        ),
        okText: '确认执行',
        cancelText: '取消',
        okButtonProps: action === 'uninstall' ? { danger: true } : undefined,
        onOk: () => { void submitAction(tool, action, key); },
        onCancel: () => setPendingActions((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        })
      });
    } catch (requestFailure: unknown) {
      setPendingActions((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      message.error(requestError(requestFailure, `${tool.name}${ACTION_LABELS[action]}计划生成失败`));
    }
  };

  return {
    data,
    loading,
    error,
    fetchTools,
    tools,
    categoryInfo,
    installedCount,
    editableCount,
    lifecycleCount,
    activeTaskFor,
    busyActionFor,
    runAction
  };
}
