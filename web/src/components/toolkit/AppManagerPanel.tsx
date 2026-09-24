import { useMemo, useState } from 'react';
import {
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
  ToolkitAppConfigResponse
} from '@/types';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import ConfigCodeEditor from './config-editor/ConfigCodeEditor';
import ManagedAppCard from './ManagedAppCard';
import { KimiDesktopLoginModal } from '@/features/accounts/KimiDesktopLoginModal';
import { SESSION_SYNC_SUMMARY } from '@/components/session-sync-copy';
import { APP_CATEGORIES, useManagedApps } from './use-managed-apps';

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
  const {
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
    busyActionFor,
    checkAppUpdate,
    runAppAction,
    installHooks
  } = useManagedApps();
  const [category, setCategory] = useState('ALL');
  const [editingApp, setEditingApp] = useState<ManagedAppItem | null>(null);
  const [configData, setConfigData] = useState<ToolkitAppConfigResponse | null>(null);
  const [configContent, setConfigContent] = useState('');
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [kimiDesktopLoginTarget, setKimiDesktopLoginTarget] = useState<{
    app: ManagedAppItem;
    accountRef: string;
  } | null>(null);

  const filteredApps = useMemo(() => {
    if (!data) return [];
    return category === 'ALL'
      ? data.apps
      : data.apps.filter((app) => app.categories.includes(category));
  }, [category, data]);

  const openManagedApp = async (app: ManagedAppItem, accountRef?: string, unscoped = false) => {
    const kind = app.type === 'desktop' ? 'desktop' : 'cli';
    try {
      const response = await toolkitAPI.openManagedApp(app.id, {
        kind,
        ...(accountRef ? { accountRef } : {}),
        ...(unscoped ? { unscoped: true } : {})
      });
      if (!response.ok) throw new Error(response.message || response.error || '桌面应用启动失败');
      message.success(response.status === 'already_running'
        ? `${app.name} 的该账号实例已在运行`
        : `${app.name} 已启动`);
      if (response.egressWarning) {
        message.warning(`ZCode 出口未生效：${response.egressWarning}`);
      }
      await refreshRunningApps();
    } catch (requestFailure: unknown) {
      const code = typeof requestFailure === 'object' && requestFailure
        ? String((requestFailure as { response?: { data?: { error?: string } } }).response?.data?.error || '')
        : '';
      if (kind === 'desktop' && app.provider === 'kimi' && accountRef
        && (code === 'kimi_desktop_session_required' || code === 'kimi_desktop_session_seed_failed')) {
        setKimiDesktopLoginTarget({ app, accountRef });
        if (code === 'kimi_desktop_session_seed_failed') {
          message.warning(requestError(requestFailure, 'Kimi Desktop 登录态需要重新托管'));
        }
        return;
      }
      message.error(requestError(requestFailure, `${app.name} 启动失败`));
    }
  };

  const closeManagedApp = async (app: ManagedAppItem, accountRef: string) => {
    const kind = app.type === 'desktop' ? 'desktop' : 'cli';
    try {
      const response = await toolkitAPI.openManagedApp(app.id, {
        kind,
        accountRef,
        action: 'close'
      });
      if (!response.ok) throw new Error(response.message || response.error || '结束应用失败');
      message.success(kind === 'desktop' ? 'Desktop 实例已结束' : '该账号的 CLI 会话已结束');
      await refreshRunningApps();
    } catch (requestFailure: unknown) {
      message.error(requestError(requestFailure, kind === 'desktop' ? '结束 Desktop 失败' : '结束 CLI 会话失败'));
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
        </div>
        <div className="toolkit-header-actions">
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => { void fetchApps(); }}>重新探测</Button>
        </div>
      </header>

      {error && (
        <div className="toolkit-inline-error" role="alert">
          <span className="hud-led hud-led--err" aria-hidden="true" />
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
              { label: '网页会话刷新', value: hookSupportedCount ? `${hookReadyCount} / ${hookSupportedCount} 个 CLI 已启用` : '无需启用', detail: SESSION_SYNC_SUMMARY, tone: hookSupportedCount === 0 ? 'neutral' : hookReadyCount === hookSupportedCount ? 'success' : 'warning' }
            ]}
          />

          <div className="toolkit-category-bar">
            <div className="toolkit-filter-scroll">
              <Segmented
                aria-label="应用分类"
                value={category}
                onChange={(value) => setCategory(String(value))}
                options={APP_CATEGORIES}
              />
            </div>
            <span className="toolkit-result-count">当前显示 {filteredApps.length} 项</span>
          </div>

          {filteredApps.length ? (
            <div className="toolkit-grid">
              {filteredApps.map((app) => (
                <ManagedAppCard
                  key={app.id}
                  app={app}
                  busyAction={busyActionFor(app)}
                  checkingUpdate={Boolean(checkingUpdates[app.id])}
                  accounts={accounts}
                  runningAccountPids={runningAccountPids}
                  runningCliAccountPids={runningCliAccountPids}
                  installingHooks={installingHooks}
                  onAction={(target, action) => void runAppAction(target, action)}
                  onCheckUpdate={(target) => void checkAppUpdate(target)}
                  onOpenApp={(target, accountRef, unscoped) => void openManagedApp(target, accountRef, unscoped)}
                  onCloseApp={(target, accountRef) => void closeManagedApp(target, accountRef)}
                  onInstallHooks={(provider) => void installHooks([provider])}
                  onEditConfig={openConfig}
                />
              ))}
            </div>
          ) : <Empty description="当前分类没有应用" />}
        </>
      ) : null}

      <KimiDesktopLoginModal
        open={Boolean(kimiDesktopLoginTarget)}
        accountRef={kimiDesktopLoginTarget?.accountRef || ''}
        accountLabel={accounts.find((account) => account.accountRef === kimiDesktopLoginTarget?.accountRef)?.displayName || ''}
        onClose={() => setKimiDesktopLoginTarget(null)}
        onSuccess={() => {
          const target = kimiDesktopLoginTarget;
          setKimiDesktopLoginTarget(null);
          if (target) void openManagedApp(target.app, target.accountRef);
        }}
      />

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
            <div className="toolkit-config-note" role="note">
              <LockOutlined aria-hidden="true" />
              <span>
                <strong>配置可能包含访问令牌或其他敏感信息</strong>
                {configData?.requiresElevation
                  ? '；当前配置需要系统授权才能保存，保存后会出现平台授权提示。'
                  : `；格式：${configData?.configFormat || editingApp?.configFormat || 'text'}，保存时会检查文件是否被其他进程修改。`}
              </span>
            </div>
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
