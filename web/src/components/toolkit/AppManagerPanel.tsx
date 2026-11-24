import { useMemo, useState } from 'react';
import { message, Segmented } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import HudStateView from '@/components/hud/HudStateView';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import { toolkitAPI } from '@/services/api';
import ToolkitEmptyState from './ToolkitEmptyState';
import ToolkitPanelHeader from './ToolkitPanelHeader';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import ManagedAppCard from './ManagedAppCard';
import type { ManagedAppLaunchTarget } from './ManagedAppAccountActions';
import AppAdvancedSettingsModal from '@/features/toolkit/AppAdvancedSettingsModal';
import { KimiDesktopLoginModal } from '@/features/accounts/KimiDesktopLoginModal';
import { desktopLoginRequiredAction } from '@/features/app-install/launch-required-action';
import { APP_CATEGORIES, useManagedApps } from './use-managed-apps';
import { describeClearBrokenResult } from './provider-cli-upgrade-presentation';
import { useProviderCliUpgrade } from './use-provider-cli-upgrade';
import { useAdoptLaunchedTerminal } from '@/features/web-terminal/use-adopt-launched-terminal';
import { resolveOrderedDirection, useSurfaceSwitch } from '@/hooks/use-surface-switch';
import { toolkitRequestError as requestError } from './request-error';

const UPGRADE_TRACK_TONES: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  success: 'success',
  warning: 'warning',
  error: 'danger',
  active: 'info',
  neutral: 'neutral'
};

export default function AppManagerPanel() {
  const adoptLaunchedTerminal = useAdoptLaunchedTerminal();
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
    installHooks,
    uninstallHooks
  } = useManagedApps();
  const {
    loading: upgradeLoading,
    error: upgradeError,
    fetchStatus: fetchUpgradeStatus,
    mode: upgradeMode,
    byProvider: upgradeByProvider,
    updatable: upgradeUpdatable,
    attention: upgradeAttention,
    clearBroken,
    clearingProvider
  } = useProviderCliUpgrade();
  const [category, setCategory] = useState('ALL');
  const { surfaceRef: appGridRef, switchSurface: switchAppGrid } = useSurfaceSwitch<HTMLDivElement>();
  const [advancedAppId, setAdvancedAppId] = useState('');
  const [kimiDesktopLoginTarget, setKimiDesktopLoginTarget] = useState<{
    app: ManagedAppLaunchTarget;
    accountRef: string;
  } | null>(null);

  const advancedApp = useMemo(
    () => data?.apps.find((app) => app.id === advancedAppId) || null,
    [advancedAppId, data]
  );

  const filteredApps = useMemo(() => {
    if (!data) return [];
    return category === 'ALL'
      ? data.apps
      : data.apps.filter((app) => app.categories.includes(category));
  }, [category, data]);

  const refreshAll = () => {
    void fetchApps();
    void fetchUpgradeStatus();
  };

  const openManagedApp = async (app: ManagedAppLaunchTarget, accountRef?: string, unscoped = false) => {
    const kind = app.type === 'desktop' ? 'desktop' : 'cli';
    try {
      const response = await toolkitAPI.openManagedApp(app.id, {
        kind,
        ...(accountRef ? { accountRef } : {}),
        ...(unscoped ? { unscoped: true } : {})
      });
      if (!response.ok) throw new Error(response.message || response.error || '桌面应用启动失败');
      const inWebTerminal = adoptLaunchedTerminal(response, app.name);
      message.success(inWebTerminal
        ? `${app.name} 已在 Web Terminal 中打开`
        : (response.status === 'already_running' ? `${app.name} 的该账号实例已在运行` : `${app.name} 已启动`));
      if (response.egressWarning) {
        message.warning(`ZCode 出口未生效：${response.egressWarning}`);
      }
      await refreshRunningApps();
    } catch (requestFailure: unknown) {
      const loginAction = kind === 'desktop' ? desktopLoginRequiredAction(requestFailure) : null;
      if (loginAction && accountRef) {
        setKimiDesktopLoginTarget({ app, accountRef });
        if (loginAction.warn) message.warning(loginAction.message || `${app.name} 登录态需要重新托管`);
        return;
      }
      message.error(requestError(requestFailure, `${app.name} 启动失败`));
    }
  };

  const closeManagedApp = async (app: ManagedAppLaunchTarget, accountRef: string) => {
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

  const handleClearUpgradeBroken = async (provider: string) => {
    const result = await clearBroken(provider);
    const text = describeClearBrokenResult(result);
    if (result.ok) message.success(`${provider}：${text}`);
    else message.error(`${provider}：${text}`, 8);
  };

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-apps-title">
      <ToolkitPanelHeader
        titleId="toolkit-apps-title"
        title="应用管理"
        subtitle="管理本机 CLI 与桌面应用安装、启停及空闲自动升级状态。"
        extra={(
          <Button
            icon={<ReloadOutlined />}
            loading={loading || upgradeLoading}
            onClick={refreshAll}
          >
            重新探测
          </Button>
        )}
      />

      {error ? (
        <InlineNote
          tone="error"
          description={error}
          action={<Button size="small" onClick={() => void fetchApps()}>重试</Button>}
        >
          应用清单读取失败
        </InlineNote>
      ) : null}
      {upgradeError ? (
        <InlineNote
          tone="error"
          description={upgradeError}
          action={<Button size="small" onClick={() => void fetchUpgradeStatus()}>重试</Button>}
        >
          升级状态读取失败
        </InlineNote>
      ) : null}

      {loading && !data ? (
        <HudStateView variant="loading" code="APPS // INVENTORY" title="正在探测主机应用清单..." compact />
      ) : data ? (
        <div className="toolkit-panel-stack">
          <ToolkitStatusTrack
            ariaLabel="应用集成状态轨道"
            items={[
              { label: '已发现', value: `${data.total} 个应用`, detail: '本机受管清单', tone: 'info' },
              { label: '安装状态', value: `${data.installedCount} 个已安装`, detail: `${data.total - data.installedCount} 个未安装`, tone: data.installedCount ? 'success' : 'neutral' },
              {
                label: '即时刷新',
                value: hookSupportedCount ? `${hookReadyCount} / ${hookSupportedCount} 已启用` : '未涉及',
                detail: hookSupportedCount ? '本地新回合即时同步到 WebUI' : '当前清单无支持项',
                tone: hookSupportedCount === 0 ? 'neutral' : hookReadyCount === hookSupportedCount ? 'success' : 'warning'
              },
              {
                label: 'CLI 自动升级',
                value: upgradeMode.label,
                detail: upgradeAttention
                  ? `${upgradeAttention} 个失败待确认`
                  : upgradeUpdatable
                    ? `${upgradeUpdatable} 个有新版`
                    : upgradeMode.detail,
                tone: upgradeAttention ? 'danger' : UPGRADE_TRACK_TONES[upgradeMode.tone]
              }
            ]}
          />

          <SettingSection
            title="应用清单"
            description="按类别筛选并执行安装、更新、卸载或打开高级设置。"
            status={(
              <SettingStatusTag
                status={filteredApps.length ? 'saved' : 'unset'}
                label={`显示 ${filteredApps.length} / ${data.total}`}
                compact
              />
            )}
          >
            <div className="toolkit-panel-section-toolbar" style={{ paddingTop: 12 }}>
              <div className="toolkit-filter-scroll">
                <Segmented
                  aria-label="应用分类"
                  value={category}
                  onChange={(value) => {
                    const next = String(value);
                    const order = APP_CATEGORIES.map((item) => item.value);
                    switchAppGrid(() => setCategory(next), {
                      current: category,
                      next,
                      direction: resolveOrderedDirection(order, category, next)
                    });
                  }}
                  options={APP_CATEGORIES}
                />
              </div>
              <span className="toolkit-result-count">共 {filteredApps.length} 项</span>
            </div>

            <div ref={appGridRef} style={{ paddingBottom: 12 }}>
              {filteredApps.length ? (
                <div className="toolkit-grid aih-fade-in">
                  {filteredApps.map((app) => (
                    <ManagedAppCard
                      key={app.id}
                      app={app}
                      busyAction={busyActionFor(app)}
                      checkingUpdate={Boolean(checkingUpdates[app.id])}
                      accounts={accounts}
                      runningAccountPids={runningAccountPids}
                      runningCliAccountPids={runningCliAccountPids}
                      upgrade={app.type === 'cli' ? (upgradeByProvider[app.provider] || null) : null}
                      clearingUpgrade={clearingProvider === app.provider}
                      onAction={(target, action) => void runAppAction(target, action)}
                      onCheckUpdate={(target) => void checkAppUpdate(target)}
                      onOpenApp={(target, accountRef, unscoped) => void openManagedApp(target, accountRef, unscoped)}
                      onCloseApp={(target, accountRef) => void closeManagedApp(target, accountRef)}
                      onClearUpgradeBroken={(provider) => void handleClearUpgradeBroken(provider)}
                      onEditConfig={(target) => setAdvancedAppId(target.id)}
                    />
                  ))}
                </div>
              ) : (
                <ToolkitEmptyState
                  title="当前分类下没有应用"
                  description="切换回全部分类可查看所有已探测到的本机应用。"
                  action={category !== 'ALL' ? (
                    <Button type="primary" size="small" onClick={() => setCategory('ALL')}>
                      查看全部应用
                    </Button>
                  ) : (
                    <Button icon={<ReloadOutlined />} size="small" onClick={refreshAll}>
                      重新探测
                    </Button>
                  )}
                />
              )}
            </div>
          </SettingSection>
        </div>
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

      <AppAdvancedSettingsModal
        open={Boolean(advancedApp)}
        app={advancedApp}
        busy={Boolean(advancedApp && busyActionFor(advancedApp))}
        installingHooks={installingHooks}
        onInstallHooks={(provider) => void installHooks([provider])}
        onUninstallHooks={(provider) => void uninstallHooks([provider])}
        onClose={() => setAdvancedAppId('')}
      />
    </section>
  );
}
