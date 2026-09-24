import { useCallback, useEffect, useRef, useState } from 'react';
import { message, Modal } from 'antd';
import { accountsAPI, toolkitAPI } from '@/services/api';
import { useWebUiTaskQueue } from '@/services/webui-task-queue';
import type {
  Account,
  ManagedAppItem,
  ManagedAppsResponse,
  ToolkitLifecycleAction,
  WebUiTask
} from '@/types';
import { getAppUpdateActionPresentation } from '@/features/app-install/app-install-presentation';
import AppActionConfirmContent from './AppActionConfirmContent';
import { LIFECYCLE_ACTION_LABELS } from './lifecycle-presentation';
import { toolkitRequestError as requestError } from './request-error';

export const APP_CATEGORIES = [
  { label: '全部', value: 'ALL' },
  { label: 'CLI 编程', value: 'CLI Code' },
  { label: '桌面客户端', value: 'Desktop' },
  { label: 'IDE 扩展', value: 'IDE' }
];

type AppAction = ToolkitLifecycleAction;
type PendingAction = { phase: 'planning' | 'submitted'; jobId?: string };

function lifecycleKind(app: ManagedAppItem): 'cli' | 'desktop' {
  return app.type === 'cli' ? 'cli' : 'desktop';
}

const actionLabel = (action: AppAction) => LIFECYCLE_ACTION_LABELS[action];
const actionKey = (app: ManagedAppItem, action: string) => `${app.id}:${action}`;

/**
 * 应用管理的数据层（桌面面板与移动端共用）：应用清单 + 账号 + 运行中实例轮询、
 * 安装 / 更新 / 卸载计划确认、检查更新、启用网页会话即时刷新。
 * 打开 / 结束应用与配置编辑仍由各自界面持有（交互差异较大）。
 */
export function useManagedApps() {
  const [data, setData] = useState<ManagedAppsResponse | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [runningAccountPids, setRunningAccountPids] = useState<Record<string, number[]>>({});
  const [runningCliAccountPids, setRunningCliAccountPids] = useState<Record<string, number[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [installingHooks, setInstallingHooks] = useState(false);
  const [pendingActions, setPendingActions] = useState<Record<string, PendingAction>>({});
  const { tasks } = useWebUiTaskQueue();
  const [checkingUpdates, setCheckingUpdates] = useState<Record<string, boolean>>({});
  const runningRefreshRef = useRef<Promise<void> | null>(null);

  const refreshRunningApps = useCallback(() => {
    if (runningRefreshRef.current) return runningRefreshRef.current;
    const request = (async () => {
      try {
        const response = await accountsAPI.listAppEntries();
        setRunningAccountPids(response.runningAccountPids);
        setRunningCliAccountPids(response.runningCliAccountPids);
      } catch (_error) {
        // 运行态是辅助信息，扫描失败不阻断应用清单。
      }
    })();
    runningRefreshRef.current = request;
    void request.then(() => {
      if (runningRefreshRef.current === request) runningRefreshRef.current = null;
    });
    return request;
  }, []);

  const fetchApps = useCallback(async (options: { showLoading?: boolean } = {}) => {
    if (options.showLoading !== false) setLoading(true);
    setError('');
    try {
      const [response, accountResponse] = await Promise.all([
        toolkitAPI.listApps(),
        accountsAPI.list().catch(() => null),
        refreshRunningApps()
      ]);
      if (!response.ok) throw new Error('应用接口未返回可用结果');
      setData(response);
      if (accountResponse) setAccounts(accountResponse.accounts || []);
    } catch (requestFailure: unknown) {
      setError(requestError(requestFailure, '读取应用列表失败'));
    } finally {
      setLoading(false);
    }
  }, [refreshRunningApps]);

  useEffect(() => {
    void fetchApps();
  }, [fetchApps]);

  useEffect(() => {
    const timer = window.setInterval(() => { void refreshRunningApps(); }, 1000);
    return () => window.clearInterval(timer);
  }, [refreshRunningApps]);

  useEffect(() => {
    if (!data || !data.apps.some((app) => app.version === '探测中')) return undefined;
    const timer = window.setTimeout(() => { void fetchApps({ showLoading: false }); }, 500);
    return () => window.clearTimeout(timer);
  }, [data, fetchApps]);

  useEffect(() => {
    const handleTaskCompleted = (event: Event) => {
      const task = (event as CustomEvent<WebUiTask>).detail;
      if (task?.source !== 'app-install' || !task.appId) return;
      setPendingActions((current) => {
        const next = { ...current };
        Object.entries(current).forEach(([key, pending]) => {
          if (pending.jobId === task.id || key.startsWith(`${task.appId}:`)) delete next[key];
        });
        return next;
      });
      void fetchApps();
    };
    window.addEventListener('aih:webui-task-completed', handleTaskCompleted);
    return () => window.removeEventListener('aih:webui-task-completed', handleTaskCompleted);
  }, [fetchApps]);

  const hookReadyCount = data?.apps.filter((app) => app.installed && app.hookSupported && app.hookInstalled).length || 0;
  const hookSupportedCount = data?.apps.filter((app) => app.installed && app.hookSupported).length || 0;

  const activeAppTasks = tasks.filter((task) => task.source === 'app-install');
  const activeTaskFor = (app: ManagedAppItem) => activeAppTasks.find((task) => (
    task.appId === app.id || (!task.appId && task.provider === app.provider)
  ));

  /** 当前应用正在进行的生命周期动作：本地待提交 / 已提交优先，其次后台队列里的任务。 */
  const busyActionFor = (app: ManagedAppItem): AppAction | undefined => (
    pendingActions[actionKey(app, 'install')]
      ? 'install'
      : pendingActions[actionKey(app, 'update')]
        ? 'update'
        : pendingActions[actionKey(app, 'uninstall')]
          ? 'uninstall'
          : (activeTaskFor(app)?.action as AppAction | undefined)
  );

  const submitAppAction = async (app: ManagedAppItem, action: AppAction, key: string) => {
    try {
      const response = await toolkitAPI.executeAppAction(app.id, action, lifecycleKind(app));
      if (!response.ok || !response.job) {
        throw new Error(response.error || '应用任务未创建');
      }
      setPendingActions((current) => ({ ...current, [key]: { phase: 'submitted', jobId: response.job?.id } }));
      message.info(`${app.name}${actionLabel(action)}任务已提交`);
    } catch (requestFailure: unknown) {
      setPendingActions((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      message.error(requestError(requestFailure, `${app.name}${actionLabel(action)}失败`));
    }
  };

  const checkAppUpdate = async (app: ManagedAppItem) => {
    if (checkingUpdates[app.id]) return;
    setCheckingUpdates((current) => ({ ...current, [app.id]: true }));
    try {
      const response = await toolkitAPI.checkAppUpdate(app.id);
      setData((current) => current ? {
        ...current,
        apps: current.apps.map((item) => item.id === app.id
          ? {
              ...item,
              version: response.currentVersion || (item.version === '探测中' ? '未探测到' : item.version),
              latestVersion: response.latestVersion,
              updateAvailable: response.updateAvailable,
              updateStatus: response.status
            }
          : item)
      } : current);
      const presentation = getAppUpdateActionPresentation(app.name, response);
      if (!presentation.shouldExecute) {
        message.success(presentation.notice);
        return;
      }
      const key = actionKey(app, 'update');
      const plan = await toolkitAPI.planAppAction(app.id, 'update', lifecycleKind(app));
      if (!plan.ok) throw new Error(plan.error || '无法生成更新计划');
      Modal.confirm({
        title: presentation.title,
        content: (
          <AppActionConfirmContent
            summary={presentation.summary}
            plans={plan.plans || []}
            metadata={presentation.metadata}
          />
        ),
        okText: '确认更新',
        cancelText: '稍后',
        onOk: () => { void submitAppAction(app, 'update', key); }
      });
    } catch (requestFailure: unknown) {
      message.error(requestError(requestFailure, `${app.name} 更新准备失败`));
    } finally {
      setCheckingUpdates((current) => {
        const next = { ...current };
        delete next[app.id];
        return next;
      });
    }
  };

  const runAppAction = async (app: ManagedAppItem, action: AppAction) => {
    const key = actionKey(app, action);
    if (activeTaskFor(app) || pendingActions[key]) return;
    setPendingActions((current) => ({ ...current, [key]: { phase: 'planning' } }));
    try {
      const plan = await toolkitAPI.planAppAction(app.id, action, lifecycleKind(app));
      if (!plan.ok) throw new Error(plan.error || '无法生成应用操作计划');
      Modal.confirm({
        title: `${actionLabel(action)} ${app.name}`,
        content: (
          <AppActionConfirmContent
            summary={`确认后将创建 ${app.name}${actionLabel(action)}任务，进度显示在后台任务队列。`}
            plans={plan.plans || []}
          />
        ),
        okText: '确认执行',
        cancelText: '取消',
        okButtonProps: action === 'uninstall' ? { danger: true } : undefined,
        onOk: () => { void submitAppAction(app, action, key); },
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
      message.error(requestError(requestFailure, `${app.name}${actionLabel(action)}计划生成失败`));
    }
  };

  const installHooks = async (providers?: string[]) => {
    if (!data) return;
    const targets = providers || data.apps
      .filter((app) => app.installed && app.hookSupported && !app.hookInstalled)
      .map((app) => app.provider);
    if (!targets.length) {
      message.info('没有待启用的网页会话刷新');
      return;
    }

    setInstallingHooks(true);
    try {
      const response = await toolkitAPI.installHooks(targets);
      const failed = (response.results || []).filter((result) => !result.ok);
      if (!response.ok || failed.length) {
        throw new Error(failed.map((result) => `${result.provider}: ${result.error || result.reason || '验证失败'}`).join('；') || '网页会话刷新未通过验证');
      }
      message.success('网页会话刷新已启用并验证');
      await fetchApps();
    } catch (requestFailure: unknown) {
      message.error(requestError(requestFailure, '网页会话刷新配置失败'));
    } finally {
      setInstallingHooks(false);
    }
  };

  return {
    data,
    accounts,
    runningAccountPids,
    runningCliAccountPids,
    loading,
    error,
    installingHooks,
    checkingUpdates,
    hookReadyCount,
    hookSupportedCount,
    fetchApps,
    refreshRunningApps,
    activeTaskFor,
    busyActionFor,
    checkAppUpdate,
    runAppAction,
    installHooks
  };
}
