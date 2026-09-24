import AccountCardGrid from '@/components/account/AccountCardGrid';
import './Accounts.css';
import React, { useState, useEffect, useMemo } from 'react';
import { StatisticCard } from '@ant-design/pro-components';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import SectionCard from '@/components/ui/SectionCard';
import ListTable from '@/components/ui/ListTable';
import { useLocation } from 'react-router-dom';
import {
  Space,
  Segmented,
  Tag,
  Badge,
  Select,
  message,
  Dropdown,
  Tooltip,
  Switch,
  Popover,
  Menu,
  Tabs
} from 'antd';
import type { MenuProps } from 'antd';
import {
  PlusOutlined,
  AppstoreOutlined,
  UnorderedListOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  ReloadOutlined,
  FilterOutlined,
  MoreOutlined,
  SyncOutlined,
  ExportOutlined,
  ImportOutlined,
  MobileOutlined,
  EditOutlined,
  CodeOutlined,
  DesktopOutlined,
  GlobalOutlined,
  QrcodeOutlined,
  UndoOutlined,
  HistoryOutlined,
} from '@ant-design/icons';
import { accountsAPI } from '@/services/api';
import { formatTimeCell } from '@/utils/datetime';
import type { AccountExportFormat } from '@/services/api';
import type { Account } from '@/types';
import { providerNames } from '@/components/chat/ProviderIcon';
import { getProviderFamily } from '@/providers/catalog';
import TokenUsageCell from '@/components/account/TokenUsageCell';
import UsageProgressEffects from '@/features/accounts/UsageProgressEffects';
import {
  useTokenDropEvents
} from '@/features/accounts/useTokenDropEvents';
import {
  canCopyAccountEmail,
  canEditAccountConfig,
  canReauthAccount,
  canRefreshUsageAccount,
  getAccountDisplayState,
  getReauthActionLabel,
  getUsageSortValue,
  hasKnownUsage,
  isAccountEnabled,
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
  EXPORT_ACTIONS,
  formatImportJobProgress
} from '@/features/accounts/account-import-export';
import {
  ACCOUNT_STATUS_FILTER_OPTIONS,
  PROVIDER_FAMILY_GROUPS,
  aggregateFamilyActivity,
  canViewQuotaResetHistory,
  countPendingIssues,
  countUnavailable,
  createProviderStats,
  familyRepresentative,
  getAccountAppSupport,
  getCodexAppAccountActionMeta,
  getDefaultAccountActionMeta,
  parseAccountRouteTarget,
  persistActiveProviderTab,
  readStoredActiveProviderTab,
  resolveAddAccountDefaultProvider,
  tallyProviderStats
} from '@/features/accounts/account-view-model';
import type {
  AccountFilterValue,
  AccountProviderFilter,
  ProviderStats
} from '@/features/accounts/account-view-model';
import {
  useAccountsSnapshot
} from '@/features/accounts/useAccountsSnapshot';
import type { UseAccountsSnapshotHandlers } from '@/features/accounts/useAccountsSnapshot';
import {
  useModelCatalog
} from '@/features/accounts/useModelCatalog';
import { useAccountActions } from '@/features/accounts/use-account-actions';
import { useAccountAppEntries } from '@/features/accounts/use-account-app-entries';
import { useAccountActivity } from '@/features/accounts/use-account-activity';
import AccountFlowModals from '@/features/accounts/AccountFlowModals';
import { AccountEgressModal } from '@/features/accounts/ZcodeEgressModal';
import {
  formatCodexResetMenuLabel,
  isCodexOAuthResetEligible
} from '@/features/accounts/codex-reset-credit-model';
import {
  getAccountPrimaryLabel,
  getAccountSecondaryLabel,
  getKimiPlanSubscription,
  formatPlanValidUntil,
  getPlanTagColor,
  getPlanTagLabel,
  renderAccountDisplayBadge,
  renderAccountRegionTag,
  renderAccountRoleIcons,
  renderAccountRoleTags
} from '@/features/accounts/AccountBadges';
import AccountActivityIcon from '@/features/accounts/AccountActivityIcon';
import { startAccountAppEntryPolling } from '@/features/accounts/app-entry-poller';

// 桌面账号页（≥ 768px）。移动端由 web/src/mobile/pages/MobileAccounts 独立渲染，
// 两端共用 features/accounts 下的数据 hook、业务动作（useAccountActions）与业务弹窗（AccountFlowModals）。

const ACCOUNTS_VIEW_MODE_STORAGE_KEY = 'accounts-view-mode:v1';

function readStoredAccountsViewMode(): 'card' | 'list' {
  if (typeof window === 'undefined') return 'card';
  try {
    const saved = window.localStorage.getItem(ACCOUNTS_VIEW_MODE_STORAGE_KEY);
    if (saved === 'card' || saved === 'list') return saved;
  } catch (_error) {}
  return 'card';
}

function persistAccountsViewMode(mode: 'card' | 'list'): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(ACCOUNTS_VIEW_MODE_STORAGE_KEY, mode); } catch (_error) {}
}

export default function Accounts() {
  const [viewMode, setViewMode] = useState<'card' | 'list'>(readStoredAccountsViewMode);
  const location = useLocation();
  const accountsHandlersRef = React.useRef<UseAccountsSnapshotHandlers>({});
  const accountsSnapshot = useAccountsSnapshot(accountsHandlersRef);
  const {
    accounts,
    hydratingDetails,
    removingAccountRefs,
    loading,
    refreshing
  } = accountsSnapshot;
  const tokenDrops = useTokenDropEvents(accounts);
  const {
    modelCatalog,
    refreshingModelAccountRefs,
    refreshAccountModelCatalog,
    clearModelAccountRefreshing,
    loadModelCatalog
  } = useModelCatalog(accounts);
  const [activeProvider, setActiveProvider] = useState<AccountProviderFilter>(() => readStoredActiveProviderTab());
  const [filterStatus, setFilterStatus] = useState<AccountFilterValue>('all');
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const accountRouteTarget = useMemo(() => parseAccountRouteTarget(location.search), [location.search]);

  // 桌面/CLI 入口按宿主机实测结果控制：加载完成前两个图标都隐藏，避免闪烁。
  // runningAccounts 记录桌面运行中的账号，用于给图标挂角标。
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

  // 网关请求活动轮询：驱动账号行首图标「运行中」旋转，转速随请求速率变化。
  const { getAccountActivity } = useAccountActivity();

  const accountActions = useAccountActions({
    snapshot: accountsSnapshot,
    handlersRef: accountsHandlersRef,
    modelCatalog: { clearModelAccountRefreshing, loadModelCatalog },
    loadAppEntries,
    onOpenAppResponse: (result) => {
      if (result.egressWarning) {
        message.warning(`账号出口未生效：${result.egressWarning}`);
      }
    }
  });
  const {
    updatingStatusAccountRefs,
    refreshingUsageAccountRefs,
    copyAccountEmail,
    handleEdit,
    handleReauth,
    confirmDeleteAccount,
    handleReload,
    handleToggleStatus,
    handleSetDefault,
    handleSetMobile,
    handleRefreshUsage,
    handleOpenApp,
    scheduleCliTerminalPicker,
    openCliWithDefaultTerminal,
    guardAccountLaunch,
    openModelManagement,
    openAddAccountModal,
    openImportModal,
    handleExport,
    exportingAccounts,
    hasActiveImportJob,
    importJob,
    setKimiDesktopLoginRequest,
    setCodexResetAccount,
    setQuotaResetHistoryAccount,
    accountEgressAccount,
    setAccountEgressAccount
  } = accountActions;

  useEffect(() => {
    persistActiveProviderTab(activeProvider);
  }, [activeProvider]);

  // 按产品族分组统计（族内所有站点账号合并计数）
  const providerStats = useMemo<ProviderStats>(() => {
    const stats = createProviderStats();
    accounts.forEach(account => tallyProviderStats(stats, account));
    return stats;
  }, [accounts]);
  const activeStats = providerStats[activeProvider] || providerStats.all;

  // 过滤账号
  const filteredAccounts = useMemo(() => {
    let filtered = accounts;

    // 按产品族过滤：族内国内站/国际站账号一起显示，各自带站点标记。
    if (activeProvider !== 'all') {
      filtered = filtered.filter(a => getProviderFamily(a.provider) === activeProvider);
    }

    // 按状态过滤
    if (filterStatus !== 'all') {
      filtered = filtered.filter((account) => getAccountDisplayState(account) === filterStatus);
    }

    return filtered;
  }, [accounts, activeProvider, filterStatus]);

  useEffect(() => {
    if (!accountRouteTarget) return;
    // 从仪表盘错误跳入账号页时，确保目标账号不会被 provider/status 过滤掉。
    // 深链 query 是真实 Provider ID，tab 轴是产品族，这里换算到所属族。
    setActiveProvider(getProviderFamily(accountRouteTarget.provider));
    setFilterStatus('all');
  }, [accountRouteTarget]);

  useEffect(() => {
    if (!accountRouteTarget || loading) return;
    const row = document.querySelector<HTMLElement>(`[data-account-ref="${accountRouteTarget.accountRef}"]`);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [accountRouteTarget, filteredAccounts, loading]);

  const handleOpenAddAccountModal = () => {
    // 弹窗内 provider 下拉默认跟随当前选中的 tab（族 → 其国际站成员），
    // 仍可在弹窗里切到组内的另一个站点。
    openAddAccountModal(resolveAddAccountDefaultProvider(activeProvider));
  };

  // 账号操作菜单（⋮）—— 列表列与卡片视图共用同一套 items + 点击分发，避免逻辑分叉。
  const buildAccountMenuItems = (record: Account): MenuProps['items'] => {
    if (requiresAccountReauth(record)) {
      return [{ key: 'reauth', label: '重新登录', icon: <SyncOutlined /> }];
    }
    const menuItems: MenuProps['items'] = [];
    const defaultAction = getDefaultAccountActionMeta(record);
    menuItems.push({
      key: 'set-default',
      label: defaultAction.label,
      icon: defaultAction.active ? <CheckCircleOutlined style={{ color: 'var(--color-accent)' }} /> : <CheckCircleOutlined />,
      disabled: defaultAction.disabled
    });
    const codexAppAction = getCodexAppAccountActionMeta(record);
    if (codexAppAction) {
      menuItems.push({
        key: 'set-mobile',
        label: codexAppAction.label,
        icon: codexAppAction.active ? <MobileOutlined style={{ color: 'var(--color-accent)' }} /> : <MobileOutlined />,
        disabled: codexAppAction.disabled
      });
    }
    if (isCodexOAuthResetEligible(record)) {
      menuItems.push({
        key: 'codex-reset-credits',
        label: formatCodexResetMenuLabel(record),
        icon: <UndoOutlined />
      });
    }
    if (canViewQuotaResetHistory(record)) {
      menuItems.push({
        key: 'quota-reset-history',
        label: '重置历史记录',
        icon: <HistoryOutlined />
      });
    }
    if (canReauthAccount(record)) {
      menuItems.push({ key: 'reauth', label: getReauthActionLabel(record), icon: <SyncOutlined /> });
    }
    if (canEditAccountConfig(record)) {
      menuItems.push({ key: 'edit', label: '编辑配置', icon: <EditOutlined /> });
    }
    menuItems.push({ key: 'account-egress', label: '出口设置', icon: <GlobalOutlined /> });
    menuItems.push({ type: 'divider' });
    menuItems.push({ key: 'delete', label: '删除账号', danger: true, icon: <DeleteOutlined /> });
    return menuItems;
  };

  const handleAccountMenuClick = (record: Account, key: string) => {
    if (requiresAccountReauth(record) && key !== 'reauth') return;
    if (key === 'set-default') { handleSetDefault(record); return; }
    if (key === 'set-mobile') { handleSetMobile(record); return; }
    if (key === 'codex-reset-credits' && isCodexOAuthResetEligible(record)) {
      setCodexResetAccount(record);
      return;
    }
    if (key === 'quota-reset-history') {
      setQuotaResetHistoryAccount(record);
      return;
    }
    if (key === 'reauth') { handleReauth(record); return; }
    if (key === 'edit' && canEditAccountConfig(record)) { handleEdit(record); return; }
    if (key === 'account-egress') {
      setAccountEgressAccount(record);
      return;
    }
    if (key === 'delete') {
      confirmDeleteAccount(record);
    }
  };

  const columns = [
    {
      title: '账号',
      dataIndex: 'displayName',
      key: 'displayName',
      width: 280,
      render: (_text: any, record: Account) => {
        const requiresReauth = requiresAccountReauth(record);
        const {
          desktopInstalled,
          desktopSupported,
          cliInstalled,
          cliSupported
        } = getAccountAppSupport(record, appEntries, appCapabilities);
        const desktopEntryClassName = desktopInstalled
          ? undefined
          : 'account-client-entry-button--uninstalled';
        const cliEntryClassName = cliInstalled
          ? undefined
          : 'account-client-entry-button--uninstalled';
        const kimiPlanSubscription = getKimiPlanSubscription(record);

        return (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ paddingTop: 3, flexShrink: 0 }}>
            <AccountActivityIcon provider={record.provider} activity={getAccountActivity(record)} size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="account-email-row" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 24 }}>
              <div style={{ fontWeight: 600, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {getAccountPrimaryLabel(record)}
                {kimiPlanSubscription && formatPlanValidUntil(kimiPlanSubscription.validUntilMs) ? (
                  <Tooltip title={`套餐有效期至 ${formatPlanValidUntil(kimiPlanSubscription.validUntilMs)}${kimiPlanSubscription.status === 'canceled' ? ' · 已取消续费，到期后不再自动续订' : ' · 订阅生效中，到期自动续订'}`}>
                    <span style={{ fontWeight: 400, fontSize: 12, color: kimiPlanSubscription.status === 'canceled' ? 'var(--color-warning)' : 'var(--color-muted)', marginLeft: 6 }}>
                      {formatPlanValidUntil(kimiPlanSubscription.validUntilMs)}
                    </span>
                  </Tooltip>
                ) : null}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                {renderAccountRoleIcons(record)}
                {canCopyAccountEmail(record) ? (
                  <Tooltip title="复制账号">
                    <Button
                      className="copy-icon-btn"
                      type="text"
                      size="small"
                      icon={<CopyOutlined />}
                      onClick={() => copyAccountEmail(record)}
                    />
                  </Tooltip>
                ) : null}
              </div>
            </div>
            {getAccountSecondaryLabel(record) ? (
              <div style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {getAccountSecondaryLabel(record)}
              </div>
            ) : null}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              {renderAccountRoleTags(record)}
              <Tag color={getPlanTagColor(record)} style={{ fontSize: 11, lineHeight: '18px', padding: '0 4px', margin: 0 }}>
                {getPlanTagLabel(record)}
              </Tag>
              {renderAccountRegionTag(record)}
              {/* 操作按钮必须保持语义化图标（DesktopOutlined / CodeOutlined），禁止替换为 ProviderIcon，避免与行首厂商主图标混淆 */}
              {appEntries && desktopSupported ? (
                <Tooltip title={requiresReauth ? '需要重新登录后才能打开 Desktop' : !record.configured ? '账号未配置，完成授权后可打开 Desktop' : runningAccounts.includes(getAccountRef(record)) ? 'Desktop 运行中（点击关闭）' : desktopInstalled ? '打开 Desktop' : '未安装 Desktop，点击后确认安装'}>
                  <Badge dot={runningAccounts.includes(getAccountRef(record))} status="success">
                    <Button
                      className={desktopEntryClassName}
                      type="text"
                      size="small"
                      aria-label={desktopInstalled
                        ? `打开 ${providerNames[record.provider] || record.provider} Desktop`
                        : `安装 ${providerNames[record.provider] || record.provider} Desktop`}
                      icon={<DesktopOutlined />}
                      disabled={requiresReauth || !record.configured}
                      onClick={(event: any) => {
                        event?.stopPropagation?.();
                        handleOpenApp(record, 'desktop');
                      }}
                    />
                  </Badge>
                </Tooltip>
              ) : null}
              {record.provider === 'kimi' ? (
                <Tooltip title={requiresReauth ? '需要重新登录后才能使用桌面托管登录' : '桌面托管登录（微信扫码）'}>
                  <Button
                    type="text"
                    size="small"
                    aria-label="kimi 桌面托管登录"
                    icon={<QrcodeOutlined />}
                    disabled={requiresReauth}
                    onClick={(event: any) => {
                      event?.stopPropagation?.();
                      setKimiDesktopLoginRequest({ account: record, openAfterLogin: false });
                    }}
                  />
                </Tooltip>
              ) : null}
              {appEntries && cliSupported ? (
                <Tooltip title={requiresReauth ? '需要重新登录后才能打开 CLI' : !record.configured ? '账号未配置，完成授权后可打开 CLI' : cliInstalled ? '单击选择终端，双击使用系统默认终端' : '未安装原生 CLI，点击后确认安装'}>
                  <Button
                    className={cliEntryClassName}
                    type="text"
                    size="small"
                    aria-label={cliInstalled
                      ? `打开 ${providerNames[record.provider] || record.provider} CLI`
                      : `安装 ${providerNames[record.provider] || record.provider} CLI`}
                    icon={<CodeOutlined />}
                    disabled={requiresReauth || !record.configured}
                    onClick={(event: any) => {
                      event?.stopPropagation?.();
                      if (!cliInstalled) {
                        void handleOpenApp(record, 'cli');
                        return;
                      }
                      scheduleCliTerminalPicker(record);
                    }}
                    onDoubleClick={(event: any) => {
                      event?.stopPropagation?.();
                      if (cliInstalled) openCliWithDefaultTerminal(record);
                    }}
                  />
                </Tooltip>
              ) : null}
            </div>
          </div>
          </div>
        );
      },
    },
    {
      title: '开关',
      dataIndex: 'status',
      key: 'status',
      width: 88,
      align: 'center' as const,
      render: (_status: any, record: Account) => {
        const accountRef = getAccountRef(record);
        const enabled = isAccountEnabled(record);
        const requiresReauth = requiresAccountReauth(record);
        return (
          <span style={{ display: 'inline-flex', justifyContent: 'center', width: 64 }}>
            <Switch
              checked={enabled}
              checkedChildren="启用"
              unCheckedChildren="关闭"
              loading={Boolean(updatingStatusAccountRefs[accountRef])}
              disabled={requiresReauth}
              onChange={(checked) => handleToggleStatus(record, checked)}
            />
          </span>
        );
      }
    },
    {
      title: '配置状态',
      dataIndex: 'configured',
      key: 'configured',
      width: 120,
      align: 'center' as const,
      render: (configured: any) => (
        <Badge
          status={configured ? 'success' : 'default'}
          text={configured ? '已配置' : '未配置'}
        />
      )
    },
    {
      title: '调度状态',
      dataIndex: 'quotaStatus',
      key: 'quotaStatus',
      width: 180,
      render: (_quotaStatus: any, record: Account) => {
        const refreshable = canRefreshUsageAccount(record);
        const refreshingUsage = Boolean(refreshingUsageAccountRefs[getAccountRef(record)]);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {renderAccountDisplayBadge(record)}
            {refreshable ? (
              <Tooltip title="刷新当前账号状态">
                <Button
                  type="text"
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={refreshingUsage}
                  onClick={() => handleRefreshUsage(record)}
                />
              </Tooltip>
            ) : null}
          </div>
        );
      }
    },
    {
      title: '模型探测',
      key: 'modelProbe',
      width: 180,
      render: (_value: any, record: Account) => {
        const requiresReauth = requiresAccountReauth(record);
        const probe = getAccountModelProbe(record, modelCatalog);
        const modelRefreshing = Boolean(refreshingModelAccountRefs[getModelRefreshAccountRef(record)]);
        const tagLabel = getModelProbeTagLabel(probe, modelRefreshing, record.provider);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} className="accounts-model-probe">
            <span
              className={requiresReauth ? undefined : 'accounts-model-probe-badge-link'}
              role={requiresReauth ? undefined : 'button'}
              tabIndex={requiresReauth ? undefined : 0}
              onClick={requiresReauth ? undefined : () => openModelManagement(record)}
              onKeyDown={requiresReauth ? undefined : (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                openModelManagement(record);
              }}
              style={{
                cursor: requiresReauth ? 'default' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                transition: 'opacity 0.2s'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
            >
              <Badge
                status={getModelProbeTagColor(probe, modelRefreshing) as any}
                text={tagLabel}
              />
            </span>
            <Tooltip title="刷新该账号模型目录">
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                loading={modelRefreshing}
                disabled={requiresReauth}
                onClick={() => refreshAccountModelCatalog(record)}
              />
            </Tooltip>
          </div>
        );
      }
    },
    {
      title: '剩余额度',
      dataIndex: 'remainingPct',
      key: 'remainingPct',
      width: 260,
      sorter: (a: Account, b: Account, sortOrder?: 'ascend' | 'descend' | null) => {
        const aKnown = hasKnownUsage(a);
        const bKnown = hasKnownUsage(b);
        if (aKnown !== bKnown) {
          const missingLastCompare = aKnown ? -1 : 1;
          return sortOrder === 'descend'
            ? -missingLastCompare
            : missingLastCompare;
        }
        const usageDiff = getUsageSortValue(a) - getUsageSortValue(b);
        if (usageDiff !== 0) return usageDiff;
        return String(getAccountRef(a)).localeCompare(String(getAccountRef(b)));
      },
      render: (_pct: any, record: Account) => (
        <UsageProgressEffects
          record={record}
          activity={getAccountActivity(record)}
          drops={tokenDrops}
        />
      )
    },
    {
      title: 'Token 用量',
      dataIndex: 'tokenUsage',
      key: 'tokenUsage',
      width: 214,
      // 单元格宽度随折叠变化，内容已居中；表头跟着居中才不会两头不齐。
      align: 'center' as const,
      render: (_value: any, record: Account) => (
        <TokenUsageCell usage={record.tokenUsage} />
      )
    },
    {
      title: '额度更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 150,
      sorter: (a: Account, b: Account) => (a.updatedAt || 0) - (b.updatedAt || 0),
      render: (timestamp: any) => {
        const t = formatTimeCell(timestamp);
        if (!t) return '-';
        return (
          <div>
            <div>{t.absolute}</div>
            <div style={{ fontSize: '12px', color: 'var(--color-muted)' }}>{t.relative}</div>
          </div>
        );
      }
    },
    {
      title: (
        <Tooltip title="仅统计经 aih server 成功转发的请求时间，不代表账号在其他客户端或本地 CLI 的全部使用记录。">
          <span>上次成功使用</span>
        </Tooltip>
      ),
      dataIndex: 'lastUsedAt',
      key: 'lastUsedAt',
      width: 160,
      sorter: (a: Account, b: Account) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0),
      render: (timestamp?: any) => {
        const t = formatTimeCell(timestamp);
        if (!t) return '-';
        return (
          <div>
            <div>{t.absolute}</div>
            <div style={{ fontSize: '12px', color: 'var(--color-muted)' }}>{t.relative}</div>
          </div>
        );
      }
    },
    {
      title: '操作',
      key: 'actions',
      width: 112,
      align: 'center' as const,
      fixed: 'right' as const,
      render: (_: any, record: Account) => (
        requiresAccountReauth(record) ? (
          <Button type="link" size="small" icon={<SyncOutlined />} onClick={() => handleReauth(record)}>
            重新登录
          </Button>
        ) : (
          <Dropdown
            menu={{
              items: buildAccountMenuItems(record),
              onClick: ({ key }: { key: string }) => handleAccountMenuClick(record, key)
            }}
            trigger={['click']}
          >
            <Button type="text" icon={<MoreOutlined />} />
          </Dropdown>
        )
      )
    }
  ];
  // 族 tab 聚合账号活动，复用行首图标组件，保证转轴与速率语义完全一致。
  // 族内多个站点（国内站/国际站）的流量相加，tab 上看到的是整个产品的活跃度。
  const providerActivity = aggregateFamilyActivity(accounts, getAccountActivity);

  const tabItems = [
    {
      key: 'all',
      label: <span style={{ padding: '0 8px' }}>全部 ({providerStats.all.total})</span>
    },
    ...PROVIDER_FAMILY_GROUPS.map((group) => {
      const representative = familyRepresentative(group.family);
      return {
        key: group.family,
        label: (
          <span style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
            <AccountActivityIcon
              provider={representative}
              activity={providerActivity[group.family] || null}
              size={14}
            />
            {group.label} ({providerStats[group.family]?.total || 0})
          </span>
        )
      };
    })
  ];
  const exportMenuItems: MenuProps['items'] = EXPORT_ACTIONS.map((action) => ({
    key: action.format,
    label: (
      <span className="accounts-export-menu-item">
        <span>{action.label}</span>
        <small>{action.description}</small>
      </span>
    )
  }));
  const exportMenuContent = (
    <Menu
      className="accounts-export-menu"
      items={exportMenuItems}
      selectable={false}
      onClick={({ key }) => {
        setExportMenuOpen(false);
        handleExport(key as AccountExportFormat);
      }}
    />
  );

  const getAccountExitClassName = React.useCallback((record: Account) => (
    removingAccountRefs[getAccountRef(record)]
      ? 'accounts-row-exiting animate__animated animate__fadeOutLeft animate__faster'
      : ''
  ), [removingAccountRefs]);

  const pendingIssueCount = countPendingIssues(activeStats);
  const unavailableCount = countUnavailable(activeStats);

  return (
    <PageScaffold ghost code="ACCOUNTS"
      title="账号管理"
      subTitle="统一管理 OAuth 和密钥账号；密钥账号的网络可达性以模型探测为准。"
      extra={(
        <>
          <Popover
            key="export"
            trigger="click"
            placement="bottomRight"
            arrow={false}
            open={exportMenuOpen}
            onOpenChange={setExportMenuOpen}
            content={exportMenuContent}
            overlayClassName="accounts-export-popover"
          >
            <Button
              icon={<ExportOutlined />}
              loading={exportingAccounts}
              disabled={exportingAccounts}
            >
              导出
            </Button>
          </Popover>
          <Button
            key="import"
            icon={<ImportOutlined />}
            disabled={hasActiveImportJob}
            onClick={openImportModal}
          >
            导入
          </Button>
          <Button
            key="add"
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleOpenAddAccountModal}
          >
            添加账号
          </Button>
        </>
      )}
    >
      {/* 顶部统计 */}
      <StatisticCard.Group className="accounts-stat-group hos-kpi-strip" direction="row" style={{ marginBottom: 16 }}>
        <StatisticCard
          className={hydratingDetails ? 'accounts-stat--accent' : 'accounts-stat--success'}
          statistic={{
            title: '账号状态',
            value: hydratingDetails ? '详情补全中' : '就绪',
            status: hydratingDetails ? 'processing' : 'success'
          }}
        />
        <StatisticCard
          className={activeStats.healthy > 0 ? 'accounts-stat--success' : 'accounts-stat--accent'}
          statistic={{
            title: '正常可用',
            value: `${activeStats.healthy} / ${activeStats.total}`
          }}
        />
        <StatisticCard
          className={pendingIssueCount > 0 ? 'accounts-stat--warning' : 'accounts-stat--accent'}
          statistic={{
            title: '待处理问题',
            value: pendingIssueCount,
            description: `需登录 ${activeStats.reauthRequired} · 阻塞 ${activeStats.runtimeBlocked} · 待校准 ${activeStats.usageAttention}`,
            valueStyle: {
              color: pendingIssueCount > 0
                ? 'var(--color-warning)'
                : undefined
            }
          }}
        />
        <StatisticCard
          className={unavailableCount > 0 ? 'accounts-stat--danger' : 'accounts-stat--accent'}
          statistic={{
            title: '耗尽/停用',
            value: unavailableCount,
            description: `耗尽 ${activeStats.exhausted} · 停池 ${activeStats.policyBlocked}`,
            valueStyle: {
              color: unavailableCount > 0
                ? 'var(--color-danger)'
                : undefined
            }
          }}
        />
      </StatisticCard.Group>

      {hasActiveImportJob ? (
        <div className="accounts-import-running" role="status" aria-live="polite">
          <SyncOutlined spin aria-hidden="true" />
          <strong>账号导入正在后台运行</strong>
          <span>{formatImportJobProgress(importJob)}</span>
        </div>
      ) : null}

      <SectionCard
        title="账号列表"
        // 面板级操作(怎么显示 / 刷新)归标题行右侧;筛选维度(provider / 状态)
        // 归下一行——按语义分组,而不是把控件散在三行里。
        extra={
          <Space size={8}>
            <Select
              value={filterStatus}
              onChange={setFilterStatus}
              style={{ width: 156 }}
              options={ACCOUNT_STATUS_FILTER_OPTIONS.map((option) => ({ label: option.label, value: option.value }))}
              suffixIcon={<FilterOutlined />}
            />
            <Segmented
              value={viewMode}
              onChange={(val) => { const next = val as 'card' | 'list'; setViewMode(next); persistAccountsViewMode(next); }}
              options={[
                { value: 'card', icon: <AppstoreOutlined />, label: '卡片' },
                { value: 'list', icon: <UnorderedListOutlined />, label: '列表' },
              ]}
            />
            <Button icon={<SyncOutlined />} onClick={handleReload} loading={refreshing}>
              刷新
            </Button>
          </Space>
        }
      >
        {/* 这三个控件此前都挂在列表模式的表格 toolbar 里,切到卡片模式整条消失。
          * 提出来两种模式共用,并按语义分两行:上一行是面板级操作(视图切换/刷新),
          * 控件统一聚在标题行成一组(状态筛选 / 视图切换 / 刷新),这一行整宽只做
          * provider 导航。曾把筛选器放进 Tabs 的 extra,省下一行却把 9 个 provider
          * 标签挤到截断("Grok"只剩"G"、溢出 ⋯ 贴着筛选器)——标签是主导航,
          * 不该为次级控件让路。 */}
        <Tabs
          className="accounts-provider-tabs"
          activeKey={activeProvider}
          onChange={(key) => setActiveProvider(key)}
          items={tabItems.map((tab) => ({ key: tab.key, label: tab.label }))}
        />
        {viewMode === 'card' ? (
          <div style={{ marginBottom: 16 }}>
            <AccountCardGrid
              accounts={filteredAccounts as any}
              provider={activeProvider as any}
              loading={loading}
              onEdit={(acc) => {
                const target = accounts.find(a => a.accountRef === acc.accountRef);
                if (target && canEditAccountConfig(target)) handleEdit(target);
              }}
              onDelete={(acc) => {
                const target = accounts.find(a => a.accountRef === acc.accountRef);
                if (target) confirmDeleteAccount(target);
              }}
              onOpenApp={(acc) => {
                const target = accounts.find(a => a.accountRef === acc.accountRef);
                if (target && guardAccountLaunch(target, 'Desktop')) void handleOpenApp(target, 'desktop');
              }}
              onOpenCli={(acc) => {
                const target = accounts.find(a => a.accountRef === acc.accountRef);
                if (!target || !guardAccountLaunch(target, 'CLI')) return;
                if (!appEntries?.[target.provider]?.cli) {
                  void handleOpenApp(target, 'cli');
                  return;
                }
                scheduleCliTerminalPicker(target);
              }}
            />
          </div>
        ) : (
          <ListTable
            headerTitle={
              <Space size={12}>
                <Badge status="success" text={`可用 ${activeStats.healthy}`} />
                {pendingIssueCount > 0 && (
                  <Badge status="warning" text={`待处理 ${pendingIssueCount}`} />
                )}
                {unavailableCount > 0 && (
                  <Badge status="error" text={`不可用 ${unavailableCount}`} />
                )}
              </Space>
            }
            dataSource={filteredAccounts}
            columns={columns}
            rowKey={(record) => record.accountRef}
            rowClassName={(record) => [
              accountRouteTarget?.accountRef === getAccountRef(record) ? 'accounts-row-target' : '',
              getAccountExitClassName(record)
            ].filter(Boolean).join(' ')}
            onRow={(record) => ({
              'data-account-ref': getAccountRef(record)
            } as React.HTMLAttributes<HTMLElement>)}
            loading={loading}
            toolbar={false as any}
            scroll={{ x: 1200 }}
          />
        )}
      </SectionCard>

      <AccountFlowModals actions={accountActions} />
      <AccountEgressModal
        account={accountEgressAccount}
        onClose={() => setAccountEgressAccount(null)}
      />
    </PageScaffold>
  );
};
