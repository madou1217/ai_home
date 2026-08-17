import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Empty,
  message,
  Modal,
  Segmented,
  Spin,
  Tooltip
} from 'antd';
import {
  CloudSyncOutlined,
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
  const [installingApp, setInstallingApp] = useState('');
  const [installingHooks, setInstallingHooks] = useState(false);
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
      const task = (event as CustomEvent<{ source?: string; appId?: string }>).detail;
      if (task?.source !== 'app-install' || !task.appId) return;
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

  const hookReadyCount = data?.apps.filter((app) => app.hookSupported && app.hookInstalled).length || 0;
  const hookSupportedCount = data?.apps.filter((app) => app.hookSupported).length || 0;

  const installApp = async (app: ManagedAppItem) => {
    setInstallingApp(app.id);
    const wasInstalled = app.installed;
    try {
      const response = await toolkitAPI.installApp(app.id);
      if (!response.ok || !response.job) {
        throw new Error(response.result?.installAttempts?.[0]?.error || '安装任务未创建');
      }
      message.info(`${app.name}${wasInstalled ? '更新' : '安装'}任务已提交，进度显示在右下角任务队列。`);
    } catch (requestFailure: unknown) {
      message.error(requestError(requestFailure, `${app.name} 安装失败`));
    } finally {
      setInstallingApp('');
    }
  };

  const installHooks = async (providers?: string[]) => {
    if (!data) return;
    const targets = providers || data.apps
      .filter((app) => app.hookSupported && !app.hookInstalled)
      .map((app) => app.provider);
    if (!targets.length) {
      message.info('没有待安装的会话 Hook');
      return;
    }

    setInstallingHooks(true);
    try {
      const response = await toolkitAPI.installHooks(targets);
      if (!response.ok) throw new Error('会话 Hook 接口返回失败');
      message.success('会话 Hook 配置已更新');
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
          <p>统一查看当前主机的 CLI、桌面客户端与 IDE 扩展。会话同步只将会话消息和运行态事件送到 WebUI；凭据和配置文件本身不会作为同步数据上传。</p>
        </div>
        <div className="toolkit-header-actions">
          <Button icon={<ReloadOutlined />} loading={loading} onClick={fetchApps}>重新探测</Button>
          {hookSupportedCount > hookReadyCount ? (
            <Tooltip title="安装各 Provider 官方会话 Hook；同步数据仅为会话事件，不上传凭据或配置文件内容。">
              <Button type="primary" icon={<CloudSyncOutlined />} loading={installingHooks} onClick={() => installHooks()}>
                安装缺失的会话 Hook
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </header>

      {error && <Alert type="error" showIcon message="应用清单读取失败" description={error} />}
      {loading && !data ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在探测应用" /></div>
      ) : data ? (
        <>
          <ToolkitStatusTrack
            ariaLabel="应用集成状态轨道"
            items={[
              { label: '实测', value: `${data.total} 个应用`, detail: '来自当前主机的应用清单', tone: 'info' },
              { label: '配置', value: `${data.installedCount} 个已安装`, detail: `${data.total - data.installedCount} 个未安装`, tone: data.installedCount ? 'success' : 'neutral' },
              { label: '会话同步', value: hookSupportedCount ? `${hookReadyCount} / ${hookSupportedCount} 个官方 Hook 已启用` : '暂无官方 Hook', detail: '仅同步会话事件和运行态，不上传凭据或配置文件内容', tone: hookSupportedCount === 0 ? 'neutral' : hookReadyCount === hookSupportedCount ? 'success' : 'warning' }
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
                  installingApp={installingApp === app.id}
                  installingHooks={installingHooks}
                  onInstall={installApp}
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
