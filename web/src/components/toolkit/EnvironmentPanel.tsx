import { useCallback, useEffect, useMemo, useState } from 'react';
import { Empty, message, Modal, Segmented, Space, Spin, Tag } from 'antd';
import {
  BookOutlined,
  CodeOutlined,
  ExperimentOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { buildAppHref } from '@/services/app-navigation';
import { toolkitAPI } from '@/services/api';
import { useWebUiTaskQueue } from '@/services/webui-task-queue';
import type {
  ClientPlatform,
  EnvironmentLifecycleAction,
  EnvironmentResourceItem,
  EnvironmentsResponse,
  WebUiTask
} from '@/types';
import AppActionConfirmContent from './AppActionConfirmContent';
import { getEnvironmentCategoryLabel } from './environment-presentation';
import InstallLifecycleAction from './InstallLifecycleAction';
import ManagedResourceCard from './ManagedResourceCard';
import ToolkitStatusTrack from './ToolkitStatusTrack';

type RuntimeId = 'node' | 'python';
type PendingAction = { phase: 'planning' | 'submitted'; jobId?: string };

const PLATFORM_LABELS: Record<ClientPlatform, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux'
};

const RUNTIME_LABELS: Record<RuntimeId, string> = {
  node: 'Node.js',
  python: 'Python'
};

const ACTION_LABELS: Record<EnvironmentLifecycleAction, string> = {
  install: '安装',
  update: '更新',
  uninstall: '卸载'
};

const ENVIRONMENT_ACTIONS: readonly EnvironmentLifecycleAction[] = [
  'install',
  'update',
  'uninstall'
];

function isEnvironmentLifecycleAction(value: unknown): value is EnvironmentLifecycleAction {
  return typeof value === 'string'
    && ENVIRONMENT_ACTIONS.includes(value as EnvironmentLifecycleAction);
}

function requestError(error: unknown, fallback: string) {
  if (typeof error === 'object' && error) {
    const candidate = error as { response?: { data?: { message?: string; error?: string } }; message?: string };
    return candidate.response?.data?.message || candidate.response?.data?.error || candidate.message || fallback;
  }
  return fallback;
}

function taskTargetsResource(task: WebUiTask, resourceId: string) {
  return task.source === 'environment'
    && (task.appId === resourceId || task.provider === resourceId);
}

function actionKey(resource: EnvironmentResourceItem, action: EnvironmentLifecycleAction) {
  return `${resource.id}:${action}`;
}

export default function EnvironmentPanel() {
  const [data, setData] = useState<EnvironmentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [runtime, setRuntime] = useState<RuntimeId>('node');
  const [pendingActions, setPendingActions] = useState<Record<string, PendingAction>>({});
  const { tasks, recentTasks } = useWebUiTaskQueue();

  const load = useCallback(async (options: { showLoading?: boolean } = {}) => {
    if (options.showLoading !== false) setLoading(true);
    setError('');
    try {
      const response = await toolkitAPI.getEnvironments();
      if (!response.ok) throw new Error('环境接口未返回可用结果');
      setData(response);
    } catch (requestFailure: unknown) {
      setError(requestError(requestFailure, '读取运行环境失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handleTaskCompleted = (event: Event) => {
      const task = (event as CustomEvent<WebUiTask>).detail;
      if (task?.source !== 'environment') return;
      setPendingActions((current) => {
        const next = { ...current };
        Object.entries(current).forEach(([key, pending]) => {
          if (pending.jobId === task.id || key.startsWith(`${task.appId || task.provider}:`)) delete next[key];
        });
        return next;
      });
      void load({ showLoading: false });
    };
    window.addEventListener('aih:webui-task-completed', handleTaskCompleted);
    return () => window.removeEventListener('aih:webui-task-completed', handleTaskCompleted);
  }, [load]);

  useEffect(() => {
    if (!recentTasks.length) return;
    setPendingActions((current) => {
      const next = { ...current };
      let changed = false;
      Object.entries(current).forEach(([key, pending]) => {
        if (!pending.jobId) return;
        const completed = recentTasks.find((task) => task.id === pending.jobId && task.source === 'environment'
          && !['queued', 'running'].includes(String(task.status || '').toLowerCase()));
        if (completed) {
          delete next[key];
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [recentTasks]);

  const environmentTasks = useMemo(
    () => tasks.filter((task) => task.source === 'environment'),
    [tasks]
  );
  const resources = useMemo(
    () => (data?.resources || []).filter((resource) => resource.runtime === runtime),
    [data, runtime]
  );
  const runtimeSummary = data?.runtimes[runtime];

  const activeTaskFor = (resource: EnvironmentResourceItem) => environmentTasks.find(
    (task) => taskTargetsResource(task, resource.id)
  );

  const busyActionFor = (resource: EnvironmentResourceItem) => {
    const pending = ENVIRONMENT_ACTIONS
      .find((action) => pendingActions[actionKey(resource, action)]);
    if (pending) return pending;
    const activeAction = activeTaskFor(resource)?.action;
    return isEnvironmentLifecycleAction(activeAction) ? activeAction : undefined;
  };

  const submitAction = async (
    resource: EnvironmentResourceItem,
    action: EnvironmentLifecycleAction,
    key: string
  ) => {
    try {
      const response = await toolkitAPI.executeEnvironmentToolAction(resource.id, action);
      if (!response.ok || !response.job) throw new Error(response.error || '运行环境任务未创建');
      setPendingActions((current) => ({
        ...current,
        [key]: { phase: 'submitted', jobId: response.job?.id }
      }));
      message.info(`${resource.name}${ACTION_LABELS[action]}任务已提交`);
    } catch (requestFailure: unknown) {
      setPendingActions((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      message.error(requestError(requestFailure, `${resource.name}${ACTION_LABELS[action]}失败`));
    }
  };

  const runAction = async (resource: EnvironmentResourceItem, action: EnvironmentLifecycleAction) => {
    const key = actionKey(resource, action);
    if (busyActionFor(resource)) return;
    setPendingActions((current) => ({ ...current, [key]: { phase: 'planning' } }));
    try {
      const response = await toolkitAPI.planEnvironmentToolAction(resource.id, action);
      if (!response.ok) throw new Error(response.error || '无法生成运行环境计划');
      Modal.confirm({
        title: `${ACTION_LABELS[action]} ${resource.name}`,
        content: (
          <AppActionConfirmContent
            summary={`确认后将创建 ${resource.name}${ACTION_LABELS[action]}任务，进度显示在后台任务队列。`}
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
        onOk: () => { void submitAction(resource, action, key); },
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
      message.error(requestError(requestFailure, `${resource.name}${ACTION_LABELS[action]}计划生成失败`));
    }
  };

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-environment-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">RUNTIME INVENTORY</div>
          <h2 id="toolkit-environment-title">运行环境</h2>
        </div>
        <div className="toolkit-header-actions">
          <Button
            icon={<BookOutlined />}
            href={buildAppHref('/toolkit/install-guide')}
          >
            安装指南与命令
          </Button>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>重新探测</Button>
        </div>
      </header>

      {error ? (
        <div className="toolkit-inline-error" role="alert">
          <strong>运行环境读取失败</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {loading && !data ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在探测运行环境" /></div>
      ) : data ? (
        <>
          <ToolkitStatusTrack
            ariaLabel="运行环境状态轨道"
            items={[
              {
                label: '当前系统',
                value: PLATFORM_LABELS[data.platform] || data.platform,
                detail: '只展示本机可执行的管理方式',
                tone: 'info'
              },
              {
                label: RUNTIME_LABELS[runtime],
                value: runtimeSummary?.currentVersion || '未检测到',
                detail: runtimeSummary?.activePath || '当前 PATH 未发现运行时',
                tone: runtimeSummary?.currentVersion ? 'success' : 'warning'
              },
              {
                label: '工具资源',
                value: `${resources.filter((resource) => resource.installed).length} / ${resources.length} 已安装`,
                detail: '安装、更新、卸载均进入后台任务队列',
                tone: resources.some((resource) => resource.installed) ? 'success' : 'neutral'
              }
            ]}
          />

          <div className="toolkit-category-bar">
            <div className="toolkit-filter-scroll">
              <Segmented
                aria-label="运行环境类型"
                value={runtime}
                onChange={(value) => setRuntime(value as RuntimeId)}
                options={[
                  { label: 'Node.js', value: 'node', icon: <CodeOutlined /> },
                  { label: 'Python', value: 'python', icon: <ExperimentOutlined /> }
                ]}
              />
            </div>
            <span className="toolkit-result-count">当前显示 {resources.length} 项</span>
          </div>

          {resources.length ? (
            <div className="toolkit-grid">
              {resources.map((resource) => {
                const activeTask = activeTaskFor(resource);
                const busyAction = busyActionFor(resource);
                const installedVersion = resource.version || (resource.installed ? '未探测到' : '未安装');
                return (
                  <ManagedResourceCard
                    key={resource.id}
                    resourceId={resource.id}
                    name={resource.name}
                    installed={resource.installed}
                    icon={(
                      <span className="toolkit-client-glyph" aria-hidden="true">
                        {resource.runtime === 'node' ? <CodeOutlined /> : <ExperimentOutlined />}
                      </span>
                    )}
                    badges={<Tag>{getEnvironmentCategoryLabel(resource.category)}</Tag>}
                    details={[
                      { label: '当前版本', value: installedVersion, muted: !resource.installed },
                      ...(resource.installed ? [{
                        label: '程序路径',
                        value: resource.executablePath || '未探测到',
                        tooltip: resource.executablePath || '未探测到可执行路径'
                      }] : []),
                      ...(resource.managedVersions.length ? [{
                        label: '受管版本',
                        value: resource.managedVersions.join('、')
                      }] : [])
                    ]}
                    actions={(
                      <Space size={6} wrap>
                        {activeTask ? (
                          <Tag color="processing">
                            {ACTION_LABELS[(activeTask.action as EnvironmentLifecycleAction) || 'update'] || '操作'}中
                            {` ${Math.round(Number(activeTask.progress?.percent || 0))}%`}
                          </Tag>
                        ) : null}
                        {!resource.installed ? (
                          <InstallLifecycleAction
                            action="install"
                            size="small"
                            iconOnly
                            tooltip={`安装 ${resource.name}`}
                            aria-label={`安装 ${resource.name}`}
                            loading={busyAction === 'install'}
                            disabled={Boolean(busyAction) || !resource.canInstall}
                            onClick={() => void runAction(resource, 'install')}
                          />
                        ) : (
                          <>
                            <InstallLifecycleAction
                              action="update"
                              size="small"
                              iconOnly
                              tooltip={`更新 ${resource.name}`}
                              aria-label={`更新 ${resource.name}`}
                              loading={busyAction === 'update'}
                              disabled={Boolean(busyAction) || !resource.canUpdate}
                              onClick={() => void runAction(resource, 'update')}
                            />
                            <InstallLifecycleAction
                              action="uninstall"
                              size="small"
                              iconOnly
                              tooltip={`卸载 ${resource.name}`}
                              aria-label={`卸载 ${resource.name}`}
                              loading={busyAction === 'uninstall'}
                              disabled={Boolean(busyAction) || !resource.canUninstall}
                              onClick={() => void runAction(resource, 'uninstall')}
                            />
                          </>
                        )}
                      </Space>
                    )}
                  />
                );
              })}
            </div>
          ) : <Empty description="当前系统没有可管理的运行环境工具" />}
        </>
      ) : null}
    </section>
  );
}
