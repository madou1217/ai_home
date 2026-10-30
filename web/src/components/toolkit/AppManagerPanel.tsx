import { useMemo, useState } from 'react';
import {
  Empty,
  message,
  Segmented,
  Spin
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import type { ManagedAppItem } from '@/types';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import ManagedAppCard from './ManagedAppCard';
import AppAdvancedSettingsModal from '@/features/toolkit/AppAdvancedSettingsModal';
import { KimiDesktopLoginModal } from '@/features/accounts/KimiDesktopLoginModal';
import { desktopLoginRequiredAction } from '@/features/app-install/launch-required-action';
import { APP_CATEGORIES, useManagedApps } from './use-managed-apps';
import { describeClearBrokenResult } from './provider-cli-upgrade-presentation';
import { useProviderCliUpgrade } from './use-provider-cli-upgrade';

const UPGRADE_TRACK_TONES: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  success: 'success',
  warning: 'warning',
  error: 'danger',
  active: 'info',
  neutral: 'neutral'
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
  // 自动升级结论挂在应用卡片上（同 provider 只给一处结论），不再有独立的升级面板。
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
  const [advancedAppId, setAdvancedAppId] = useState('');
  const [kimiDesktopLoginTarget, setKimiDesktopLoginTarget] = useState<{
    app: ManagedAppItem;
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
      const loginAction = kind === 'desktop' ? desktopLoginRequiredAction(requestFailure) : null;
      if (loginAction && accountRef) {
        setKimiDesktopLoginTarget({ app, accountRef });
        if (loginAction.warn) message.warning(loginAction.message || `${app.name} 登录态需要重新托管`);
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

  const handleClearUpgradeBroken = async (provider: string) => {
    const result = await clearBroken(provider);
    const text = describeClearBrokenResult(result);
    if (result.ok) message.success(`${provider}：${text}`);
    else message.error(`${provider}：${text}`, 8);
  };

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-apps-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">APPLICATION INVENTORY</div>
          <h2 id="toolkit-apps-title">应用管理</h2>
          <p>应用清单与 provider CLI 的自动升级结论在同一张卡片上：新版本只在该 CLI 空闲时生效，不会打断进行中的会话。</p>
        </div>
        <div className="toolkit-header-actions">
          <Button
            icon={<ReloadOutlined />}
            loading={loading || upgradeLoading}
            onClick={() => { void fetchApps(); void fetchUpgradeStatus(); }}
          >
            重新探测
          </Button>
        </div>
      </header>

      {error && (
        <div className="toolkit-inline-error" role="alert">
          <span className="hud-led hud-led--err" aria-hidden="true" />
          <strong>应用清单读取失败</strong>
          <span>{error}</span>
        </div>
      )}
      {upgradeError && (
        <div className="toolkit-inline-error" role="alert">
          <span className="hud-led hud-led--err" aria-hidden="true" />
          <strong>升级状态读取失败</strong>
          <span>{upgradeError}</span>
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
              { label: '即时刷新', value: hookSupportedCount ? `${hookReadyCount} / ${hookSupportedCount} 个 CLI 已启用` : '无需启用', detail: '新回合写入本地会话后可立即在 WebUI 看到', tone: hookSupportedCount === 0 ? 'neutral' : hookReadyCount === hookSupportedCount ? 'success' : 'warning' },
              {
                label: 'CLI 自动升级',
                value: upgradeMode.label,
                detail: upgradeAttention
                  ? `${upgradeAttention} 个异常需要人工确认 · ${upgradeMode.detail}`
                  : upgradeUpdatable
                    ? `${upgradeUpdatable} 个有新版 · ${upgradeMode.detail}`
                    : upgradeMode.detail,
                tone: upgradeAttention ? 'danger' : UPGRADE_TRACK_TONES[upgradeMode.tone]
              }
            ]}
          />

          <div className="toolkit-category-bar aih-fade-in">
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
