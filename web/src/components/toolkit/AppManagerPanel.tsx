import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Empty,
  message,
  Modal,
  Segmented,
  Spin
} from 'antd';
import {
  LockOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import type {
  ManagedAppItem,
  ManagedAppsResponse,
  ToolkitAppConfigResponse
} from '@/types';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import ConfigCodeEditor from './config-editor/ConfigCodeEditor';
import ManagedAppCard from './ManagedAppCard';
import { useWebUiTaskQueue } from '@/services/webui-task-queue';
import type { WebUiTask } from '@/types';
import { SESSION_SYNC_POLICY, SESSION_SYNC_BOUNDARY, SESSION_SYNC_SCOPE } from '@/components/session-sync-copy';

const APP_CATEGORIES = [
  { label: '全部', value: 'ALL' },
  { label: 'CLI 编程', value: 'CLI Code' },
  { label: '桌面客户端', value: 'Desktop' },
  { label: 'IDE 扩展', value: 'IDE' }
];

function requestError(error: unknown, fallback: string) {
  if (typeof error === 'object' && error) {
    const candidate = error as {
      response?: { data?: { message?: string; error?: string } };
      message?: string;
    };
    return candidate.response?.data?.message
      || candidate.response?.data?.error
      || candidate.message
      || fallback;
  }
  return fallback;
}

export default function AppManagerPanel() {
  const [data, setData] = useState<ManagedAppsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [category, setCategory] = useState('ALL');
  const [installingHooks, setInstallingHooks] = useState(false);
  const [pendingActions, setPendingActions] = useState<Record<string, { phase: 'planning' | 'submitted'; jobId?: string }>>({});
  const { tasks } = useWebUiTaskQueue();
  const [editingApp, setEditingApp] = useState<ManagedAppItem | null>(null);
  const [configData, setConfigData] = useState<ToolkitAppConfigResponse | null>(null);
  const [configContent, setConfigContent] = useState('');
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);

  const fetchApps = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await toolkitAPI.listApps();
      if (!response.ok) throw new Error('应用接口未返回可用结果');
      setData(response);
    } catch (requestFailure: unknown) {
      setError(requestError(requestFailure, '读取应用列表失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchApps();
  }, [fetchApps]);

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

  const filteredApps = useMemo(() => {
    if (!data) return [];
    return category === 'ALL'
      ? data.apps
      : data.apps.filter((app) => app.categories.includes(category));
  }, [category, data]);

  const hookReadyCount = data?.apps.filter((app) => app.installed && app.hookSupported && app.hookInstalled).length || 0;
  const hookSupportedCount = data?.apps.filter((app) => app.installed && app.hookSupported).length || 0;

  const activeAppTasks = tasks.filter((task) => task.source === 'app-install');
  const actionLabel = (action: 'install' | 'update' | 'uninstall') => ({ install: '安装', update: '更新', uninstall: '卸载' })[action];
  const actionKey = (app: ManagedAppItem, action: string) => `${app.id}:${action}`;
  const activeTaskFor = (app: ManagedAppItem) => activeAppTasks.find((task) => (
    task.appId === app.id || (!task.appId && task.provider === app.provider)
  ));

  const submitAppAction = async (app: ManagedAppItem, action: 'install' | 'update' | 'uninstall', key: string) => {
    try {
      const response = await toolkitAPI.executeAppAction(app.id, action, app.type === 'ide' ? undefined : app.type);
      if (!response.ok || !response.job) {
        throw new Error(response.error || '应用任务未创建');
      }
      setPendingActions((current) => ({ ...current, [key]: { phase: 'submitted', jobId: response.job?.id } }));
      message.info(`${app.name}${actionLabel(action)}任务已提交，按钮状态跟随真实任务进度。`);
    } catch (requestFailure: unknown) {
      setPendingActions((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      message.error(requestError(requestFailure, `${app.name}${actionLabel(action)}失败`));
    }
  };

  const openManagedDesktopApp = async (app: ManagedAppItem) => {
    try {
      const response = await toolkitAPI.openManagedDesktopApp(app.id);
      if (!response.ok) throw new Error(response.message || response.error || '桌面应用启动失败');
      message.success(`${app.name} 已打开`);
    } catch (requestFailure: unknown) {
      message.error(requestError(requestFailure, `${app.name} 打开失败`));
    }
  };

  const runAppAction = async (app: ManagedAppItem, action: 'install' | 'update' | 'uninstall') => {
    const key = actionKey(app, action);
    if (activeTaskFor(app) || pendingActions[key]) return;
    setPendingActions((current) => ({ ...current, [key]: { phase: 'planning' } }));
    try {
      const plan = await toolkitAPI.planAppAction(app.id, action, app.type === 'ide' ? undefined : app.type);
      if (!plan.ok) throw new Error(plan.error || '无法生成应用操作计划');
      const commands = (plan.plans || []).map((item) => `${item.label || item.id}\n${item.command} ${(item.args || []).join(' ')}`).join('\n\n');
      Modal.confirm({
        title: `${actionLabel(action)} ${app.name}`,
        content: <div style={{ whiteSpace: 'pre-wrap' }}>{commands || '将执行官方应用生命周期命令。'}</div>,
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
      message.info('没有待安装的会话 Hook');
      return;
    }

    setInstallingHooks(true);
    try {
      const response = await toolkitAPI.installHooks(targets);
      const failed = (response.results || []).filter((result) => !result.ok);
      if (!response.ok || failed.length) {
        throw new Error(failed.map((result) => `${result.provider}: ${result.error || result.reason || '验证失败'}`).join('；') || '会话同步未通过验证');
      }
      message.success('会话同步已写入并重新读取验证');
      await fetchApps();
    } catch (requestFailure: unknown) {
      message.error(requestError(requestFailure, '会话 Hook 配置失败'));
    } finally {
      setInstallingHooks(false);
    }
  };

  const openConfig = async (app: ManagedAppItem) => {
    if (!app.configExists || !app.configName) return;
    setEditingApp(app);
    setConfigData(null);
    setConfigContent('');
    setConfigLoading(true);
    try {
      const response = await toolkitAPI.getAppConfig(app.id);
      if (!response.ok) throw new Error('配置接口未返回可用结果');
      setConfigData(response);
      setConfigContent(response.content || '');
    } catch (requestFailure: unknown) {
      setEditingApp(null);
      message.error(requestError(requestFailure, '读取配置失败'));
    } finally {
      setConfigLoading(false);
    }
  };

  const saveConfig = async () => {
    if (!editingApp || !configData) return;
    setConfigSaving(true);
    try {
      const response = await toolkitAPI.saveAppConfig(editingApp.id, configContent, configData.revision);
      if (!response.ok) throw new Error('配置保存接口返回失败');
      setConfigData(response);
      message.success(response.elevated ? '配置已通过系统授权保存' : '配置已保存');
      await fetchApps();
    } catch (requestFailure: unknown) {
      message.error(requestError(requestFailure, '保存配置失败'));
    } finally {
      setConfigSaving(false);
    }
  };

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-apps-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">APPLICATION INVENTORY</div>
          <h2 id="toolkit-apps-title">应用管理</h2>
          <p>统一查看当前主机的 CLI、桌面客户端与 IDE 扩展。{SESSION_SYNC_POLICY}同步范围：{SESSION_SYNC_SCOPE}。{SESSION_SYNC_BOUNDARY}</p>
        </div>
        <div className="toolkit-header-actions">
          <Button icon={<ReloadOutlined />} loading={loading} onClick={fetchApps}>重新探测</Button>
        </div>
      </header>

      {error && (
        <div className="toolkit-inline-error" role="alert">
          <strong>应用清单读取失败</strong>
          <span>{error}</span>
        </div>
      )}
      {loading && !data ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在探测应用" /></div>
      ) : data ? (
        <>
          <ToolkitStatusTrack
            ariaLabel="应用集成状态轨道"
            items={[
              { label: '实测', value: `${data.total} 个应用`, detail: '来自当前主机的应用清单', tone: 'info' },
              { label: '配置', value: `${data.installedCount} 个已安装`, detail: `${data.total - data.installedCount} 个未安装`, tone: data.installedCount ? 'success' : 'neutral' },
              { label: '会话同步', value: hookSupportedCount ? `${hookReadyCount} / ${hookSupportedCount} 个已安装 CLI 已验证` : '无可按需启用的 Hook', detail: `同步${SESSION_SYNC_SCOPE}；${SESSION_SYNC_BOUNDARY}`, tone: hookSupportedCount === 0 ? 'neutral' : hookReadyCount === hookSupportedCount ? 'success' : 'warning' }
            ]}
          />

          <div className="toolkit-category-bar">
            <div className="toolkit-filter-scroll">
              <Segmented value={category} onChange={(value) => setCategory(String(value))} options={APP_CATEGORIES} />
            </div>
            <span className="toolkit-result-count">当前显示 {filteredApps.length} 项</span>
          </div>

          {filteredApps.length ? (
            <div className="toolkit-grid">
              {filteredApps.map((app) => (
                <ManagedAppCard
                  key={app.id}
                  app={app}
                  busyAction={pendingActions[actionKey(app, 'install')] ? 'install' : pendingActions[actionKey(app, 'update')] ? 'update' : pendingActions[actionKey(app, 'uninstall')] ? 'uninstall' : (activeTaskFor(app)?.action as 'install' | 'update' | 'uninstall' | undefined)}
                  installingHooks={installingHooks}
                  onAction={(target, action) => void runAppAction(target, action)}
                  onOpenApp={(target) => void openManagedDesktopApp(target)}
                  onInstallHooks={(provider) => void installHooks([provider])}
                  onEditConfig={openConfig}
                />
              ))}
            </div>
          ) : <Empty description="当前分类没有应用" />}
        </>
      ) : null}

      <Modal
        open={Boolean(editingApp)}
        title={editingApp ? `编辑 ${editingApp.name} 配置` : '编辑配置'}
        width={1000}
        confirmLoading={configSaving}
        okText="保存配置"
        cancelText="取消"
        onOk={saveConfig}
        onCancel={() => {
          if (!configSaving) {
            setEditingApp(null);
            setConfigData(null);
            setConfigContent('');
          }
        }}
        destroyOnClose
      >
        {configLoading ? (
          <div className="toolkit-loading compact"><Spin /></div>
        ) : (
          <>
            <Alert
              type="warning"
              showIcon
              icon={<LockOutlined />}
              className="toolkit-modal-alert"
              message="配置可能包含访问令牌或其他敏感信息"
              description={configData?.requiresElevation
                ? '当前配置需要系统授权才能保存，保存后会出现平台授权提示。'
                : `格式：${configData?.configFormat || editingApp?.configFormat || 'text'}；保存时会检查文件是否被其他进程修改。`}
            />
            <ConfigCodeEditor
              value={configContent}
              onChange={setConfigContent}
              format={configData?.configFormat || editingApp?.configFormat}
              fileName={configData?.configName || editingApp?.configName}
              ariaLabel={`${editingApp?.name || '应用'} 配置内容`}
              onSave={configSaving ? undefined : () => void saveConfig()}
            />
          </>
        )}
      </Modal>
    </section>
  );
}
