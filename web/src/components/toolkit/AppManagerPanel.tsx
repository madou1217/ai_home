import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Empty,
  message,
  Modal,
  Segmented,
  Space,
  Spin,
  Tag,
  Tooltip
} from 'antd';
import {
  CloudSyncOutlined,
  DownloadOutlined,
  EditOutlined,
  LockOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import ProviderIcon from '@/components/chat/ProviderIcon';
import { toolkitAPI, waitForAppInstallJob } from '@/services/api';
import type {
  ManagedAppItem,
  ManagedAppsResponse,
  Provider,
  ToolkitAppConfigResponse
} from '@/types';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import ConfigCodeEditor from './config-editor/ConfigCodeEditor';

const APP_CATEGORIES = [
  { label: '全部', value: 'ALL' },
  { label: 'CLI 编程', value: 'CLI Code' },
  { label: '桌面客户端', value: 'Desktop' },
  { label: 'IDE 扩展', value: 'IDE' },
  { label: '自主 Agent', value: 'Agents' }
];

const SYNC_MODE_LABELS: Record<ManagedAppItem['syncMode'], string> = {
  hook: '配置变化后自动同步',
  polling: '定期检查配置变化',
  unavailable: '需要手动刷新'
};

const APP_TYPE_LABELS: Record<ManagedAppItem['type'], string> = {
  cli: 'CLI',
  desktop: '桌面客户端',
  ide: 'IDE 扩展'
};

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
      const completed = await waitForAppInstallJob(response.job.id, (job) => {
        message.open({
          key: `toolkit-install-${app.id}`,
          type: job.status === 'failed' ? 'error' : 'loading',
          content: `${app.name} 安装进度 ${Math.round(Number(job.progress?.percent || 0))}%${job.progress?.label ? ` · ${job.progress.label}` : ''}`,
          duration: job.status === 'failed' ? 4 : 0
        });
      });
      if (completed.status !== 'succeeded') throw new Error(completed.error || '安装未完成');
      message.success({
        key: `toolkit-install-${app.id}`,
        content: wasInstalled ? `${app.name} 更新完成` : `${app.name} 安装完成`,
        duration: 3
      });
      await fetchApps();
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
      message.info('所有可用的自动同步均已启用');
      return;
    }

    setInstallingHooks(true);
    try {
      const response = await toolkitAPI.installHooks(targets);
      if (!response.ok) throw new Error('自动同步接口返回失败');
      message.success('自动同步配置已更新');
      await fetchApps();
    } catch (requestFailure: unknown) {
      message.error(requestError(requestFailure, '自动同步配置失败'));
    } finally {
      setInstallingHooks(false);
    }
  };

  const openConfig = async (app: ManagedAppItem) => {
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
          <p>统一查看 AI 客户端、CLI 与 IDE 扩展的安装状态、配置和自动同步能力。</p>
        </div>
        <div className="toolkit-header-actions">
          <Button icon={<ReloadOutlined />} loading={loading} onClick={fetchApps}>重新探测</Button>
          <Button type="primary" icon={<CloudSyncOutlined />} loading={installingHooks} onClick={() => installHooks()}>
            启用待配置的自动同步
          </Button>
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
              { label: '指南', value: `${hookReadyCount} / ${hookSupportedCount} 个自动同步已启用`, detail: '仅对明确支持自动同步的应用计数', tone: hookSupportedCount === 0 ? 'neutral' : hookReadyCount === hookSupportedCount ? 'success' : 'warning' }
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
                <article key={app.id} className={`toolkit-app-card ${app.installed ? 'installed' : 'uninstalled'}`}>
                  <div>
                    <div className="toolkit-card-header">
                      <div className="toolkit-card-title-group">
                        <ProviderIcon provider={app.provider as Provider} size={28} />
                        <div>
                          <h3 className="toolkit-card-title">{app.name}</h3>
                          <Space size={4} wrap>
                            <Tag color="blue">{APP_TYPE_LABELS[app.type]}</Tag>
                            <Tag color={app.installed ? 'success' : 'default'}>{app.installed ? '已安装' : '未安装'}</Tag>
                            {app.hookSupported && <Tag color={app.hookInstalled ? 'blue' : 'warning'}>{app.hookInstalled ? '自动同步已启用' : '自动同步待启用'}</Tag>}
                          </Space>
                        </div>
                      </div>
                    </div>
                    <dl className="toolkit-card-body">
                      <div className="toolkit-detail-row"><dt className="toolkit-detail-label">版本</dt><dd className="toolkit-detail-value">{app.version || '未探测到'}</dd></div>
                      <div className="toolkit-detail-row"><dt className="toolkit-detail-label">主模型</dt><dd className="toolkit-detail-value">{app.type === 'cli' ? (app.defaultModel || '未声明') : '由应用自身管理'}</dd></div>
                      <div className="toolkit-detail-row">
                        <dt className="toolkit-detail-label">程序路径</dt>
                        <dd className="toolkit-detail-value"><Tooltip title={app.cliPath || '未探测到可执行路径'}>{app.cliPath || '未探测到'}</Tooltip></dd>
                      </div>
                      <div className="toolkit-detail-row"><dt className="toolkit-detail-label">配置</dt><dd className="toolkit-detail-value">{app.configExists ? `${app.configName} 已存在` : `${app.configName || '默认配置'} 待创建`}</dd></div>
                    </dl>
                  </div>
                  <div className="toolkit-card-actions">
                    <Space size={6} wrap>
                      {(app.type === 'cli' || (app.type === 'desktop' && app.installAvailable)) && (
                        <Button size="small" type={app.installed ? 'default' : 'primary'} icon={<DownloadOutlined />} loading={installingApp === app.id} onClick={() => installApp(app)}>
                          {app.installed ? '更新' : '安装'}
                        </Button>
                      )}
                      {app.hookSupported && !app.hookInstalled && (
                        <Button size="small" icon={<CloudSyncOutlined />} loading={installingHooks} onClick={() => installHooks([app.provider])}>启用自动同步</Button>
                      )}
                      {app.configName && <Button size="small" icon={<EditOutlined />} onClick={() => openConfig(app)}>编辑配置</Button>}
                    </Space>
                    <span className="toolkit-sync-mode">{SYNC_MODE_LABELS[app.syncMode]}</span>
                  </div>
                </article>
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
