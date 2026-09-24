import React, { useEffect, useMemo, useRef, useState } from 'react';
import { message } from 'antd';
import { useLocation } from 'react-router-dom';
import {
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  ImportOutlined,
  PlusOutlined,
  SyncOutlined
} from '@ant-design/icons';
import {
  EmptySignal,
  HudCard,
  HudChips,
  HudIconButton,
  HudSection,
  MobilePage,
  MobileToolbar,
  MonoList,
  SwipeRow,
  TelemetryGrid,
  TelemetryTile
} from '@/mobile/ui';
import type { HudChipItem, SwipeAction } from '@/mobile/ui';
import type { MobilePageProps } from '@/mobile/mobile-routes';
import MobileBoot from '@/mobile/MobileBoot';
import { accountsAPI } from '@/services/api';
import type { Account } from '@/types';
import { getProviderFamily } from '@/providers/catalog';
import AccountActivityIcon from '@/features/accounts/AccountActivityIcon';
import { getAccountPrimaryLabel } from '@/features/accounts/AccountBadges';
import AccountFlowModals from '@/features/accounts/AccountFlowModals';
import { AccountEgressModal } from '@/features/accounts/ZcodeEgressModal';
import { useAccountsSnapshot } from '@/features/accounts/useAccountsSnapshot';
import type { UseAccountsSnapshotHandlers } from '@/features/accounts/useAccountsSnapshot';
import { useModelCatalog } from '@/features/accounts/useModelCatalog';
import { useTokenDropEvents } from '@/features/accounts/useTokenDropEvents';
import { useAccountActions } from '@/features/accounts/use-account-actions';
import { useAccountAppEntries } from '@/features/accounts/use-account-app-entries';
import { useAccountActivity } from '@/features/accounts/use-account-activity';
import { startAccountAppEntryPolling } from '@/features/accounts/app-entry-poller';
import { formatImportJobProgress } from '@/features/accounts/account-import-export';
import {
  canEditAccountConfig,
  canReauthAccount,
  getReauthActionLabel,
  requiresAccountReauth
} from '@/features/accounts/account-state';
import {
  getAccountModelProbe,
  getAccountRef,
  getModelProbeTagColor,
  getModelProbeTagLabel,
  getModelRefreshAccountRef
} from '@/features/accounts/account-model-catalog';
import {
  ACCOUNT_STATUS_FILTER_OPTIONS,
  PROVIDER_FAMILY_GROUPS,
  aggregateFamilyActivity,
  buildProviderStats,
  countPendingIssues,
  countUnavailable,
  familyRepresentative,
  filterAccountsByView,
  getAccountAppSupport,
  getStatusFilterCount,
  parseAccountRouteTarget,
  persistActiveProviderTab,
  readStoredActiveProviderTab,
  resolveAddAccountDefaultProvider
} from '@/features/accounts/account-view-model';
import type { AccountFilterValue, AccountProviderFilter } from '@/features/accounts/account-view-model';
import AccountRowContent from './accounts/AccountRowContent';
import AccountDetailSheet from './accounts/AccountDetailSheet';
import type { AccountModelProbeView } from './accounts/AccountDetailSheet';
import ExportAccountsSheet from './accounts/ExportAccountsSheet';
import { badgeStatusTone } from './accounts/account-tones';
import styles from './MobileAccounts.module.css';

/**
 * /accounts 移动端：Provider 族芯片（真实分族计数）+ 状态筛选 + 遥测 KPI + 账号等宽列表。
 * 数据与动作全部来自 features/accounts（与桌面 Accounts.tsx 同一套 hook / 业务弹窗）。
 */
export default function MobileAccounts(_props: MobilePageProps) {
  const location = useLocation();
  const handlersRef = React.useRef<UseAccountsSnapshotHandlers>({});
  const snapshot = useAccountsSnapshot(handlersRef);
  const { accounts, hydratingDetails, removingAccountRefs, loading, refreshing } = snapshot;
  const tokenDrops = useTokenDropEvents(accounts);
  const {
    modelCatalog,
    refreshingModelAccountRefs,
    refreshAccountModelCatalog,
    clearModelAccountRefreshing,
    loadModelCatalog
  } = useModelCatalog(accounts);
  const {
    appEntries,
    appCapabilities,
    runningAccounts,
    applyAppEntries,
    markAppEntriesUnavailable,
    loadAppEntries
  } = useAccountAppEntries();
  useEffect(() => startAccountAppEntryPolling({
    request: () => accountsAPI.listAppEntries(),
    onResult: applyAppEntries,
    onError: markAppEntriesUnavailable
  }), [applyAppEntries, markAppEntriesUnavailable]);
  const { getAccountActivity } = useAccountActivity();
  const actions = useAccountActions({
    snapshot,
    handlersRef,
    modelCatalog: { clearModelAccountRefreshing, loadModelCatalog },
    loadAppEntries,
    onOpenAppResponse: (result) => {
      if (result.egressWarning) {
        message.warning(`账号出口未生效：${result.egressWarning}`);
      }
    }
  });

  const [activeProvider, setActiveProvider] = useState<AccountProviderFilter>(() => readStoredActiveProviderTab());
  const [filterStatus, setFilterStatus] = useState<AccountFilterValue>('all');
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const routeTarget = useMemo(() => parseAccountRouteTarget(location.search), [location.search]);
  const handledRouteTargetRef = useRef('');

  useEffect(() => {
    persistActiveProviderTab(activeProvider);
  }, [activeProvider]);

  // 仪表盘深链 ?provider=&accountRef=：切到所属产品族、清空状态筛选，加载后打开该账号详情。
  useEffect(() => {
    if (!routeTarget) return;
    setActiveProvider(getProviderFamily(routeTarget.provider));
    setFilterStatus('all');
  }, [routeTarget]);

  useEffect(() => {
    if (!routeTarget || loading) return;
    const key = `${routeTarget.provider}:${routeTarget.accountRef}`;
    if (handledRouteTargetRef.current === key) return;
    if (!accounts.some((account) => getAccountRef(account) === routeTarget.accountRef)) return;
    handledRouteTargetRef.current = key;
    document.querySelector<HTMLElement>(`[data-account-ref="${routeTarget.accountRef}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setSelectedRef(routeTarget.accountRef);
  }, [accounts, loading, routeTarget]);

  const providerStats = useMemo(() => buildProviderStats(accounts), [accounts]);
  const activeStats = providerStats[activeProvider] || providerStats.all;
  const filteredAccounts = useMemo(
    () => filterAccountsByView(accounts, activeProvider, filterStatus),
    [accounts, activeProvider, filterStatus]
  );
  const providerActivity = aggregateFamilyActivity(accounts, getAccountActivity);
  const pendingIssues = countPendingIssues(activeStats);
  const unavailable = countUnavailable(activeStats);

  const selectedAccount = selectedRef
    ? accounts.find((account) => getAccountRef(account) === selectedRef) || null
    : null;

  // 账号被删除 / 从快照移除后自动收起详情抽屉。
  useEffect(() => {
    if (selectedRef && !loading && !accounts.some((account) => getAccountRef(account) === selectedRef)) {
      setSelectedRef(null);
    }
  }, [accounts, loading, selectedRef]);

  const providerChips: HudChipItem[] = [
    { key: 'all', label: '全部', count: providerStats.all.total },
    ...PROVIDER_FAMILY_GROUPS.map((group) => ({
      key: group.family,
      label: group.label,
      count: providerStats[group.family]?.total || 0,
      icon: (
        <AccountActivityIcon
          provider={familyRepresentative(group.family)}
          activity={providerActivity[group.family] || null}
          size={14}
        />
      )
    }))
  ];

  const statusChips: HudChipItem[] = ACCOUNT_STATUS_FILTER_OPTIONS.map((option) => ({
    key: option.value,
    label: option.label,
    count: getStatusFilterCount(activeStats, option.value)
  }));

  const openCli = (record: Account) => {
    if (!actions.guardAccountLaunch(record, 'CLI')) return;
    if (!appEntries?.[record.provider]?.cli) {
      void actions.handleOpenApp(record, 'cli');
      return;
    }
    void actions.chooseCliTerminal(record);
  };

  // 左滑与详情抽屉底部共用的主操作；需重新登录的账号只暴露「重新登录」（与桌面一致）。
  const buildPrimaryActions = (record: Account): SwipeAction[] => {
    if (requiresAccountReauth(record)) {
      return [{
        key: 'reauth',
        label: '重新登录',
        icon: <SyncOutlined />,
        tone: 'primary',
        onAction: () => { void actions.handleReauth(record); }
      }];
    }
    const list: SwipeAction[] = [];
    const support = getAccountAppSupport(record, appEntries, appCapabilities);
    if (appEntries && support.cliSupported) {
      list.push({
        key: 'cli',
        label: '终端',
        icon: <CodeOutlined />,
        disabled: !record.configured,
        onAction: () => openCli(record)
      });
    }
    if (canEditAccountConfig(record)) {
      list.push({ key: 'edit', label: '编辑', icon: <EditOutlined />, onAction: () => actions.handleEdit(record) });
    } else if (canReauthAccount(record)) {
      list.push({
        key: 'reauth',
        label: getReauthActionLabel(record),
        icon: <SyncOutlined />,
        onAction: () => { void actions.handleReauth(record); }
      });
    }
    list.push({
      key: 'delete',
      label: '删除',
      icon: <DeleteOutlined />,
      tone: 'danger',
      onAction: () => actions.confirmDeleteAccount(record)
    });
    return list;
  };

  const getModelProbeView = (record: Account): AccountModelProbeView => {
    const probe = getAccountModelProbe(record, modelCatalog);
    const refreshingModels = Boolean(refreshingModelAccountRefs[getModelRefreshAccountRef(record)]);
    return {
      label: getModelProbeTagLabel(probe, refreshingModels, record.provider),
      tone: badgeStatusTone(getModelProbeTagColor(probe, refreshingModels)),
      refreshing: refreshingModels
    };
  };

  const resetFilters = () => {
    setActiveProvider('all');
    setFilterStatus('all');
  };

  const toolbar = (
    <MobileToolbar
      start={(
        <HudIconButton
          icon={<SyncOutlined spin={refreshing} />}
          label="刷新"
          disabled={refreshing}
          onClick={() => { void actions.handleReload(); }}
        />
      )}
    >
      <HudIconButton
        icon={<ExportOutlined />}
        label="导出"
        loading={actions.exportingAccounts}
        onClick={() => setExportOpen(true)}
      />
      <HudIconButton
        icon={<ImportOutlined />}
        label="导入"
        disabled={actions.hasActiveImportJob}
        onClick={actions.openImportModal}
      />
      <HudIconButton
        icon={<PlusOutlined />}
        label="添加账号"
        tone="primary"
        showLabel
        onClick={() => actions.openAddAccountModal(resolveAddAccountDefaultProvider(activeProvider))}
      />
    </MobileToolbar>
  );

  const selectedSupport = selectedAccount ? getAccountAppSupport(selectedAccount, appEntries, appCapabilities) : null;

  return (
    <MobilePage
      toolbar={toolbar}
      lead="统一管理 OAuth 和密钥账号；密钥账号的网络可达性以模型探测为准。"
    >
      <TelemetryGrid>
        <TelemetryTile
          label="正常可用"
          value={`${activeStats.healthy}/${activeStats.total}`}
          tone={activeStats.healthy > 0 ? 'ok' : 'muted'}
          led
          track={activeStats.total > 0 ? (activeStats.healthy / activeStats.total) * 100 : null}
        />
        <TelemetryTile
          label="账号状态"
          value={hydratingDetails ? '补全中' : '就绪'}
          tone={hydratingDetails ? 'info' : 'ok'}
          led={hydratingDetails ? 'live' : true}
          sub={hydratingDetails ? '详情补全中' : undefined}
        />
        <TelemetryTile
          label="待处理问题"
          value={pendingIssues}
          tone={pendingIssues > 0 ? 'warn' : 'muted'}
          led={pendingIssues > 0}
          sub={`需登录 ${activeStats.reauthRequired} · 阻塞 ${activeStats.runtimeBlocked} · 待校准 ${activeStats.usageAttention}`}
        />
        <TelemetryTile
          label="耗尽/停用"
          value={unavailable}
          tone={unavailable > 0 ? 'err' : 'muted'}
          led={unavailable > 0}
          sub={`耗尽 ${activeStats.exhausted} · 停池 ${activeStats.policyBlocked}`}
        />
      </TelemetryGrid>

      {actions.hasActiveImportJob ? (
        <HudCard code="IMPORT" title="账号导入正在后台运行" tone="info">
          <span className={styles.importProgress} role="status" aria-live="polite">
            <SyncOutlined spin aria-hidden="true" />
            {formatImportJobProgress(actions.importJob)}
          </span>
        </HudCard>
      ) : null}

      <HudSection title="Provider" code="PROV">
        <HudChips
          ariaLabel="按 Provider 筛选账号"
          items={providerChips}
          value={activeProvider}
          onChange={(key) => setActiveProvider(key)}
        />
        <HudChips
          ariaLabel="按状态筛选账号"
          items={statusChips}
          value={filterStatus}
          onChange={(key) => setFilterStatus(key as AccountFilterValue)}
        />
      </HudSection>

      <HudSection title="账号列表" code="POOL" count={filteredAccounts.length}>
        {loading && accounts.length === 0 ? (
          <MobileBoot label="LOADING ACCOUNTS" />
        ) : filteredAccounts.length === 0 ? (
          accounts.length === 0 ? (
            <EmptySignal
              description="还没有账号。添加 OAuth 或密钥账号，或从文件导入。"
              action={(
                <HudIconButton
                  icon={<PlusOutlined />}
                  label="添加账号"
                  tone="primary"
                  showLabel
                  onClick={() => actions.openAddAccountModal(resolveAddAccountDefaultProvider(activeProvider))}
                />
              )}
            />
          ) : (
            <EmptySignal
              description="没有符合条件的账号"
              action={(
                <HudIconButton icon={<SyncOutlined />} label="显示全部账号" showLabel onClick={resetFilters} />
              )}
            />
          )
        ) : (
          <MonoList ariaLabel="账号列表">
            {filteredAccounts.map((record) => {
              const accountRef = getAccountRef(record);
              return (
                <SwipeRow
                  key={accountRef}
                  actions={buildPrimaryActions(record)}
                  onTap={() => setSelectedRef(accountRef)}
                  ariaLabel={`查看 ${getAccountPrimaryLabel(record)} 详情`}
                >
                  <AccountRowContent
                    record={record}
                    activity={getAccountActivity(record)}
                    removing={Boolean(removingAccountRefs[accountRef])}
                    desktopRunning={runningAccounts.includes(accountRef)}
                  />
                </SwipeRow>
              );
            })}
          </MonoList>
        )}
      </HudSection>

      <AccountDetailSheet
        record={selectedAccount}
        onClose={() => setSelectedRef(null)}
        actions={actions}
        primaryActions={selectedAccount ? buildPrimaryActions(selectedAccount) : []}
        appSupport={selectedSupport}
        appEntriesLoaded={Boolean(appEntries)}
        desktopRunning={selectedAccount ? runningAccounts.includes(getAccountRef(selectedAccount)) : false}
        activity={selectedAccount ? getAccountActivity(selectedAccount) : null}
        drops={tokenDrops}
        modelProbe={selectedAccount ? getModelProbeView(selectedAccount) : null}
        onRefreshModels={(record) => { void refreshAccountModelCatalog(record); }}
      />
      <ExportAccountsSheet
        open={exportOpen}
        exporting={actions.exportingAccounts}
        onClose={() => setExportOpen(false)}
        onExport={(format) => { void actions.handleExport(format); }}
      />
      <AccountFlowModals actions={actions} />
      <AccountEgressModal
        account={actions.accountEgressAccount}
        onClose={() => actions.setAccountEgressAccount(null)}
      />
    </MobilePage>
  );
}
