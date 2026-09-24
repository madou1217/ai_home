import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { message } from 'antd';
import {
  CloudSyncOutlined,
  DeleteOutlined,
  DownloadOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  StarFilled,
  StopOutlined
} from '@ant-design/icons';
import ProviderIcon from '@/components/chat/ProviderIcon';
import { SESSION_SYNC_SUMMARY } from '@/components/session-sync-copy';
import {
  getAppCurrentVersion,
  getAppHookStatusDetail,
  hasExistingAppConfig,
  managedAppAccountIsRunning,
  managedAppAccountLabel,
  sortManagedAppAccounts,
  SYNC_MODE_LABELS
} from '@/components/toolkit/managed-app-presentation';
import { toolkitRequestError as requestError } from '@/components/toolkit/request-error';
import { APP_CATEGORIES, useManagedApps } from '@/components/toolkit/use-managed-apps';
import { KimiDesktopLoginModal } from '@/features/accounts/KimiDesktopLoginModal';
import { renderAccountRegionTag } from '@/features/accounts/AccountBadges';
import MobileBoot from '@/mobile/MobileBoot';
import {
  DetailSheet,
  EmptySignal,
  HudChips,
  HudSection,
  KeyValue,
  MonoList,
  SwipeRow,
  TelemetryGrid,
  TelemetryTile
} from '@/mobile/ui';
import type { SwipeAction } from '@/mobile/ui';
import { toolkitAPI } from '@/services/api';
import type { Account, ManagedAppItem } from '@/types';
import { ActionButton, InlineError, Note, PanelToolbar, StatusText, TaskStatus } from './toolkit-parts';
import styles from '../MobileToolkit.module.css';

const TYPE_CODES: Record<ManagedAppItem['type'], string> = {
  cli: 'CLI',
  desktop: 'DESKTOP',
  ide: 'IDE'
};

function canLaunch(app: ManagedAppItem) {
  return app.installed && (app.type === 'cli' || app.type === 'desktop');
}

/** 应用管理：清单 + 左滑生命周期操作 + 详情抽屉 + 选择账号打开。 */
export default function AppsPanel() {
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
    activeTaskFor,
    busyActionFor,
    checkAppUpdate,
    runAppAction,
    installHooks
  } = useManagedApps();
  const [category, setCategory] = useState('ALL');
  const [detailId, setDetailId] = useState('');
  const [launchId, setLaunchId] = useState('');
  const [kimiDesktopLoginTarget, setKimiDesktopLoginTarget] = useState<{ app: ManagedAppItem; accountRef: string } | null>(null);

  const filteredApps = useMemo(() => {
    if (!data) return [];
    return category === 'ALL'
      ? data.apps
      : data.apps.filter((app) => app.categories.includes(category));
  }, [category, data]);

  const detailApp = data?.apps.find((app) => app.id === detailId) || null;
  const launchApp = data?.apps.find((app) => app.id === launchId) || null;

  const runningPidsFor = (app: ManagedAppItem) => (app.type === 'desktop' ? runningAccountPids : runningCliAccountPids);
  const hasRunningAccount = (app: ManagedAppItem) => sortManagedAppAccounts(accounts, app.provider)
    .some((account) => managedAppAccountIsRunning(account, runningPidsFor(app)));

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

  const lifecycleActions = (app: ManagedAppItem): SwipeAction[] => {
    const busy = Boolean(busyActionFor(app));
    const checking = Boolean(checkingUpdates[app.id]);
    const actions: SwipeAction[] = [];
    if (canLaunch(app)) {
      actions.push({
        key: 'open',
        label: '打开',
        icon: <PlayCircleOutlined />,
        tone: 'primary',
        disabled: busy,
        onAction: () => setLaunchId(app.id)
      });
    }
    if (!app.installed && app.installAvailable) {
      actions.push({
        key: 'install',
        label: '安装',
        icon: <DownloadOutlined />,
        tone: 'primary',
        disabled: busy,
        onAction: () => void runAppAction(app, 'install')
      });
    }
    if (app.installed) {
      actions.push({
        key: 'update',
        label: checking ? '检查中' : '更新',
        icon: <ReloadOutlined />,
        disabled: busy || checking || app.canUpdate === false,
        onAction: () => void checkAppUpdate(app)
      });
      actions.push({
        key: 'uninstall',
        label: '卸载',
        icon: <DeleteOutlined />,
        tone: 'danger',
        disabled: busy || app.canUninstall === false,
        onAction: () => void runAppAction(app, 'uninstall')
      });
    }
    return actions;
  };

  const rowStatus = (app: ManagedAppItem) => {
    const task = activeTaskFor(app);
    if (task) return <TaskStatus task={task} />;
    const busy = busyActionFor(app);
    if (busy) return <StatusText tone="info" live>准备中</StatusText>;
    if (!app.installed) return <StatusText tone="muted">未安装</StatusText>;
    if (canLaunch(app) && hasRunningAccount(app)) return <StatusText tone="ok" live>运行中</StatusText>;
    return <StatusText tone="ok">已安装</StatusText>;
  };

  if (loading && !data) return <MobileBoot label="PROBING APPS" />;

  return (
    <>
      <PanelToolbar
        status={data ? `当前显示 ${filteredApps.length} 项` : null}
        refreshLabel="重新探测"
        refreshing={loading}
        onRefresh={() => { void fetchApps(); }}
      />

      {error ? <InlineError title="应用清单读取失败" detail={error} onRetry={() => { void fetchApps(); }} retrying={loading} /> : null}

      {data ? (
        <>
          <TelemetryGrid>
            <TelemetryTile label="实测应用" value={data.total} unit="个" tone="info" sub="来自当前主机的应用清单" />
            <TelemetryTile
              label="已安装"
              value={data.installedCount}
              unit={`/ ${data.total}`}
              tone={data.installedCount ? 'ok' : 'muted'}
              led
              sub={`${data.total - data.installedCount} 个未安装`}
            />
            <TelemetryTile
              wide
              label="网页会话刷新"
              value={hookSupportedCount ? `${hookReadyCount} / ${hookSupportedCount}` : '无需启用'}
              unit={hookSupportedCount ? '个 CLI 已启用' : undefined}
              tone={hookSupportedCount === 0 ? 'muted' : hookReadyCount === hookSupportedCount ? 'ok' : 'warn'}
              led={hookSupportedCount > 0}
              sub={SESSION_SYNC_SUMMARY}
            />
          </TelemetryGrid>

          <HudChips
            ariaLabel="应用分类"
            value={category}
            onChange={setCategory}
            items={APP_CATEGORIES.map((item) => ({ key: item.value, label: item.label }))}
          />

          <HudSection title="应用清单" code="APPS" count={filteredApps.length}>
            {filteredApps.length ? (
              <MonoList ariaLabel="应用清单">
                {filteredApps.map((app) => (
                  <SwipeRow
                    key={app.id}
                    actions={lifecycleActions(app)}
                    onTap={() => setDetailId(app.id)}
                    ariaLabel={`${app.name} 详情`}
                  >
                    <span className="mhud-row__icon"><ProviderIcon provider={app.provider} size={20} fallbackLabel={app.provider.slice(0, 3).toUpperCase()} /></span>
                    <span className="mhud-row__main">
                      <span className="mhud-row__title">{app.name}</span>
                      <span className="mhud-row__meta">{TYPE_CODES[app.type]} · {getAppCurrentVersion(app)}</span>
                    </span>
                    <span className="mhud-row__side">{rowStatus(app)}</span>
                  </SwipeRow>
                ))}
              </MonoList>
            ) : (
              <EmptySignal description="当前分类没有应用" />
            )}
          </HudSection>
        </>
      ) : null}

      <DetailSheet
        open={Boolean(detailApp)}
        onClose={() => setDetailId('')}
        code={detailApp ? `APP // ${TYPE_CODES[detailApp.type]}` : 'APP'}
        title={detailApp?.name || '应用'}
        footer={detailApp ? <AppSheetFooter
          app={detailApp}
          busy={Boolean(busyActionFor(detailApp))}
          busyAction={busyActionFor(detailApp)}
          checking={Boolean(checkingUpdates[detailApp.id])}
          onOpen={() => setLaunchId(detailApp.id)}
          onInstall={() => void runAppAction(detailApp, 'install')}
          onUpdate={() => void checkAppUpdate(detailApp)}
          onUninstall={() => void runAppAction(detailApp, 'uninstall')}
        /> : null}
      >
        {detailApp ? (
          <AppDetail
            app={detailApp}
            status={rowStatus(detailApp)}
            installingHooks={installingHooks}
            busy={Boolean(busyActionFor(detailApp))}
            onInstallHooks={() => void installHooks([detailApp.provider])}
          />
        ) : null}
      </DetailSheet>

      <DetailSheet
        open={Boolean(launchApp)}
        onClose={() => setLaunchId('')}
        code="LAUNCH // ACCOUNT"
        title={launchApp ? `选择账号打开 ${launchApp.name}` : '选择账号'}
        footer={launchApp && launchApp.type === 'cli' ? (
          <ActionButton
            icon={<PlusOutlined />}
            label="无账号新开 CLI"
            disabled={Boolean(busyActionFor(launchApp))}
            onClick={() => {
              setLaunchId('');
              void openManagedApp(launchApp, undefined, true);
            }}
          />
        ) : null}
      >
        {launchApp ? (
          <AccountLauncher
            app={launchApp}
            accounts={accounts}
            runningPids={runningPidsFor(launchApp)}
            disabled={Boolean(busyActionFor(launchApp))}
            onOpen={(accountRef) => {
              setLaunchId('');
              void openManagedApp(launchApp, accountRef);
            }}
            onClose={(accountRef) => void closeManagedApp(launchApp, accountRef)}
          />
        ) : null}
      </DetailSheet>

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
    </>
  );
}

function AppDetail({ app, status, installingHooks, busy, onInstallHooks }: {
  app: ManagedAppItem;
  status: ReactNode;
  installingHooks: boolean;
  busy: boolean;
  onInstallHooks: () => void;
}) {
  const hookDetail = getAppHookStatusDetail(app);
  const rows = [
    { key: 'status', label: '状态', value: status },
    { key: 'version', label: '当前版本', value: getAppCurrentVersion(app), tone: app.installed ? undefined : 'muted' as const },
    ...(app.installed ? [{ key: 'path', label: '程序路径', value: app.cliPath || '未探测到' }] : []),
    ...(hasExistingAppConfig(app) ? [{ key: 'config', label: '配置', value: `${app.configName} 已存在` }] : []),
    ...(app.installed && app.hookSupported ? [{
      key: 'hook',
      label: '即时刷新',
      value: app.hookInstalled
        ? <StatusText tone="info">已启用</StatusText>
        : <StatusText tone="warn">待启用</StatusText>
    }] : []),
    ...(app.type === 'cli' ? [{ key: 'sync', label: '网页会话刷新', value: SYNC_MODE_LABELS[app.syncMode], mono: false }] : [])
  ];
  return (
    <div className={styles.sheetStack}>
      <KeyValue rows={rows} />
      {hookDetail ? <Note tone="warn">{hookDetail}</Note> : null}
      {app.installed && app.hookSupported && !app.hookInstalled ? (
        <div className={styles.sheetBlock}>
          <p className={styles.prose}>{SESSION_SYNC_SUMMARY} 启用后会重新读取配置并验证。</p>
          <ActionButton
            icon={<CloudSyncOutlined />}
            label="启用即时刷新"
            loading={installingHooks}
            disabled={busy}
            onClick={onInstallHooks}
          />
        </div>
      ) : null}
    </div>
  );
}

function AppSheetFooter({ app, busy, busyAction, checking, onOpen, onInstall, onUpdate, onUninstall }: {
  app: ManagedAppItem;
  busy: boolean;
  busyAction?: string;
  checking: boolean;
  onOpen: () => void;
  onInstall: () => void;
  onUpdate: () => void;
  onUninstall: () => void;
}) {
  if (!app.installed) {
    return app.installAvailable ? (
      <ActionButton icon={<DownloadOutlined />} label="安装" tone="primary" loading={busyAction === 'install'} disabled={busy} onClick={onInstall} />
    ) : (
      <span className={styles.footerNote}>当前主机不提供自动安装</span>
    );
  }
  return (
    <>
      {canLaunch(app) ? (
        <ActionButton icon={<PlayCircleOutlined />} label="打开" tone="primary" disabled={busy} onClick={onOpen} />
      ) : null}
      <ActionButton
        icon={<ReloadOutlined />}
        label="更新"
        loading={checking || busyAction === 'update'}
        disabled={busy || checking || app.canUpdate === false}
        onClick={onUpdate}
      />
      <ActionButton
        icon={<DeleteOutlined />}
        label="卸载"
        tone="danger"
        loading={busyAction === 'uninstall'}
        disabled={busy || app.canUninstall === false}
        onClick={onUninstall}
      />
    </>
  );
}

/** 与桌面账号下拉同一套规则：默认账号在前；未配置且未运行的账号不可打开；运行中可结束 / CLI 可新开会话。 */
function AccountLauncher({ app, accounts, runningPids, disabled, onOpen, onClose }: {
  app: ManagedAppItem;
  accounts: Account[];
  runningPids: Record<string, number[]>;
  disabled: boolean;
  onOpen: (accountRef: string) => void;
  onClose: (accountRef: string) => void;
}) {
  const kind = app.type === 'desktop' ? 'desktop' : 'cli';
  const providerAccounts = sortManagedAppAccounts(accounts, app.provider);
  const defaultAccount = providerAccounts.find((account) => account.isDefault && account.configured);
  const ordered = defaultAccount
    ? [defaultAccount, ...providerAccounts.filter((account) => account.accountRef !== defaultAccount.accountRef)]
    : providerAccounts;

  if (!ordered.length) {
    return (
      <EmptySignal
        title="NO ACCOUNT"
        description={kind === 'desktop' ? '暂无可用账号' : '当前 Provider 没有账号，可使用下方「无账号新开 CLI」。'}
      />
    );
  }

  return (
    <div className={styles.accountList} role="list" aria-label={`${app.name} 可用账号`}>
      {ordered.map((account) => {
        const running = managedAppAccountIsRunning(account, runningPids);
        const label = managedAppAccountLabel(account);
        const isDefault = account.accountRef === defaultAccount?.accountRef;
        const openable = account.configured || running;
        return (
          <div key={account.accountRef} className={styles.accountRow} role="listitem">
            <button
              type="button"
              className={styles.accountMain}
              disabled={disabled || !openable}
              onClick={() => onOpen(account.accountRef)}
              aria-label={`用 ${label} 打开 ${app.name}`}
            >
              <span className={styles.accountName}>
                {isDefault ? <StarFilled className={styles.accountStar} aria-hidden="true" /> : null}
                {isDefault ? '默认账号 · ' : ''}{label}
              </span>
              <span className={styles.accountMeta}>
                {running ? <StatusText tone="ok" live>运行中</StatusText> : null}
                {!account.configured ? <StatusText tone="muted">未配置</StatusText> : null}
                {renderAccountRegionTag(account)}
              </span>
            </button>
            {running ? (
              <span className={styles.accountActions}>
                <button
                  type="button"
                  className={`${styles.miniButton} ${styles.miniButton_danger}`}
                  disabled={disabled}
                  aria-label={`结束 ${label} 的${kind === 'desktop' ? '桌面实例' : '全部 CLI 会话'}`}
                  onClick={() => onClose(account.accountRef)}
                >
                  <StopOutlined />
                  <span>结束</span>
                </button>
                {kind === 'cli' ? (
                  <button
                    type="button"
                    className={styles.miniButton}
                    disabled={disabled}
                    aria-label={`为 ${label} 新开 CLI 会话`}
                    onClick={() => onOpen(account.accountRef)}
                  >
                    <PlusOutlined />
                    <span>新开</span>
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
