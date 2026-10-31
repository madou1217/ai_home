import AccountCardGrid from '@/components/account/AccountCardGrid';
import './Accounts.css';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { StatisticCard } from '@ant-design/pro-components';
import AnimatedValue from '@/components/ui/AnimatedValue';
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
  Tabs,
  Typography
} from 'antd';
import type { MenuProps } from 'antd';
import {
  PlusOutlined,
  AppstoreOutlined,
  UnorderedListOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  CopyOutlined,
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
  ReloadOutlined,
  ClockCircleOutlined,
  BranchesOutlined,
  FieldNumberOutlined,
  GiftOutlined,
  FileSearchOutlined,
} from '@ant-design/icons';
import { accountsAPI } from '@/services/api';
import { formatTimeCell } from '@/utils/datetime';
import type { AccountExportFormat } from '@/services/api';
import type { Account, AccountActivityAction, AccountActivityJob, AccountActivityResult } from '@/types';
import { providerNames } from '@/components/chat/ProviderIcon';
import { getProviderFamily } from '@/providers/catalog';
import TokenUsageCell from '@/components/account/TokenUsageCell';
import UsageProgressEffects from '@/features/accounts/UsageProgressEffects';
import {
  useTokenDropEvents
} from '@/features/accounts/useTokenDropEvents';
import {
  canConfigureWindowActivation,
  canCopyAccountEmail,
  canEditAccountConfig,
  canEditAccountRoutingRules,
  canReauthAccount,
  canRestoreAccountScheduling,
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
import { useSwitchFade } from '@/hooks/use-switch-fade';
import { useAccountAppEntries } from '@/features/accounts/use-account-app-entries';
import { useAccountActivity } from '@/features/accounts/use-account-activity';
import AccountFlowModals from '@/features/accounts/AccountFlowModals';
import { AccountEgressModal } from '@/features/accounts/ZcodeEgressModal';
import { AccountWindowActivationModal } from '@/features/accounts/AccountWindowActivationModal';
import { AccountAliasPoolModal } from '@/features/accounts/AccountAliasPoolModal';
import AccountConfigFilesModal from '@/features/accounts/AccountConfigFilesModal';
import { AccountModelContextModal } from '@/features/accounts/AccountModelContextModal';
import { AccountActivityModal } from '@/features/accounts/AccountActivityModal';
import { AccountEgressBadge } from '@/features/egress-upstream/AccountEgressBadge';
import AccountEgressBulkPicker from '@/features/egress-upstream/AccountEgressBulkPicker';
import { useAccountEgressSummary } from '@/features/egress-upstream/use-account-egress-summary';
import {
  formatCodexResetMenuLabel,
  isCodexOAuthResetEligible
} from '@/features/accounts/codex-reset-credit-model';
import {
  getAccountPrimaryLabel,
  getAccountSecondaryLabel,
  getPlanTagColor,
  getPlanTagLabel,
  renderAccountDisplayBadge,
  renderAccountRegionTag,
  renderAccountRoleTags
} from '@/features/accounts/AccountBadges';
import AccountRefreshLogo from '@/features/accounts/AccountRefreshLogo';
import AccountActivityIcon from '@/features/accounts/AccountActivityIcon';
import AccountSubscriptionLines from '@/features/accounts/AccountSubscriptionLines';
import { startAccountAppEntryPolling } from '@/features/accounts/app-entry-poller';
import { useAccountOutcomes } from '@/features/account-status/useAccountOutcomes';
import GlobalStatusPanel from '@/features/account-status/GlobalStatusPanel';
import AccountHealthIcon from '@/features/account-status/AccountHealthIcon';

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

function isActivityJobTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'partial' || status === 'failed';
}

export default function Accounts() {
  const [viewMode, setViewMode] = useState<'card' | 'list'>(readStoredAccountsViewMode);
  const viewBodyRef = useRef<HTMLDivElement | null>(null);
  // 卡片/列表两个分支的根都是 div，React 会复用节点 → 分支上的挂载动画不会重播。
  // 这里只做一次只碰 opacity 的切换淡入，不强制重挂（否则列表的排序/展开态会丢）。
  useSwitchFade(viewBodyRef, viewMode, { scope: 'accounts-view-mode' });
  const location = useLocation();
  const accountsHandlersRef = React.useRef<UseAccountsSnapshotHandlers>({});
  const accountsSnapshot = useAccountsSnapshot(accountsHandlersRef);
  const {
    accounts,
    hydratingDetails,
    removingAccountRefs,
    loading
  } = accountsSnapshot;
  const tokenDrops = useTokenDropEvents(accounts);
  const accountOutcomes = useAccountOutcomes();
  const {
    modelCatalog,
    refreshingModelAccountRefs,
    clearModelAccountRefreshing,
    loadModelCatalog
  } = useModelCatalog(accounts);
  const [activeProvider, setActiveProvider] = useState<AccountProviderFilter>(() => readStoredActiveProviderTab());
  const [filterStatus, setFilterStatus] = useState<AccountFilterValue>('all');
  // 按需扫描本机已登录账号（CodeBuddy / WorkBuddy 家族与 Cline）：不等待后台轮询，结果当场可见。
  const [detectingHostAccounts, setDetectingHostAccounts] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const accountRouteTarget = useMemo(() => parseAccountRouteTarget(location.search), [location.search]);

  // 桌面/CLI 入口按宿主机实测结果控制：加载完成前两个图标都隐藏，避免闪烁。
  // runningAccounts 记录桌面运行中的账号，用于给图标挂角标。
  const {
    appEntries,
    appCapabilities,
    serverRuntime,
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
    serverRuntime,
    onOpenAppResponse: (result) => {
      if (result.egressWarning) {
        message.warning(`账号出口未生效：${result.egressWarning}`);
      }
    }
  });
  const {
    updatingStatusAccountRefs,
    refreshingUsageAccountRefs,
    refreshingAccountRefs,
    copyAccountEmail,
    handleEdit,
    handleRoutingRules,
    handleRestoreScheduling,
    handleReauth,
    confirmDeleteAccount,
    handleToggleStatus,
    handleSetDefault,
    handleSetMobile,
    handleRefreshUsage,
    handleRefreshAccount,
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
    setAccountEgressAccount,
    accountWindowActivationAccount,
    setAccountWindowActivationAccount
  } = accountActions;

  // 账号出口摘要：列表 / 卡片上的出口徽标与「批量设置出口」共用（见 features/egress-upstream）。
  const egressSummary = useAccountEgressSummary();
  const [bulkEgressOpen, setBulkEgressOpen] = useState(false);
  // 账号活动（签到 / 领臭鸡蛋）：入口只在声明了该动作的供应商 tab 出现；
  // 动作清单来自服务端下发的 activityActions，前端不判断 provider。
  const [rewardsRunning, setRewardsRunning] = useState(false);
  const [rewardsOpen, setRewardsOpen] = useState(false);
  const [rewardsTitle, setRewardsTitle] = useState('');
  const [rewardsResults, setRewardsResults] = useState<AccountActivityResult[]>([]);
  const [rewardsJob, setRewardsJob] = useState<AccountActivityJob | null>(null);
  const rewardsPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [aliasPoolAccount, setAliasPoolAccount] = useState<Account | null>(null);
  const [configFilesAccount, setConfigFilesAccount] = useState<Account | null>(null);
  const [modelContextAccount, setModelContextAccount] = useState<Account | null>(null);

  const renderEgressBadge = (record: Account) => (
    <AccountEgressBadge
      entry={egressSummary.byAccount.get(getAccountRef(record))}
      onOpen={() => setAccountEgressAccount(record)}
    />
  );

  useEffect(() => {
    persistActiveProviderTab(activeProvider);
  }, [activeProvider]);

  // 页面卸载时停止轮询；后台任务本身在服务端继续跑，重新进入页面不会重复领取。
  useEffect(() => () => {
    if (rewardsPollTimer.current) clearTimeout(rewardsPollTimer.current);
  }, []);

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

  // 当前供应商 tab 下可见账号声明的动作（按动作 id 去重，providers 记录族内哪些站点可执行）。
  // “全部” tab 不提供入口：动作只在支持它的供应商菜单下出现。
  const visibleActivityActions = useMemo(() => {
    if (activeProvider === 'all') return [];
    const actions = new Map<string, { action: AccountActivityAction; providers: Set<string> }>();
    for (const record of filteredAccounts) {
      for (const action of record.activityActions || []) {
        const entry = actions.get(action.id) || { action, providers: new Set<string>() };
        entry.providers.add(record.provider);
        actions.set(action.id, entry);
      }
    }
    return [...actions.values()].map(({ action, providers }) => ({
      action,
      providers: [...providers]
    }));
  }, [activeProvider, filteredAccounts]);

  const rewardsProgressText = rewardsJob && rewardsRunning
    ? (rewardsJob.status === 'queued'
      ? `${rewardsJob.actionLabel}：排队中，共 ${rewardsJob.progress.total} 个账号`
      : `${rewardsJob.actionLabel}：进行中 ${rewardsJob.progress.completed}/${rewardsJob.progress.total}`)
    : '';

  const renderProviderActivityActions = () => (
    <Space size={8} wrap>
      {visibleActivityActions.map(({ action, providers }) => (
        <Button
          key={action.id}
          size="small"
          icon={<GiftOutlined />}
          title={action.description || action.label}
          loading={rewardsJob?.actionId === action.id ? rewardsRunning : false}
          disabled={rewardsRunning}
          onClick={() => void runProviderRewards(action, providers)}
        >
          {action.label}
        </Button>
      ))}
      {rewardsProgressText ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {rewardsProgressText}
        </Typography.Text>
      ) : null}
    </Space>
  );

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

  // 领取结果只带 provider + accountRef；展示名由页面补（与账号行同一套文案）。
  const presentRewards = (results: AccountActivityResult[], title?: string) => {
    if (title) setRewardsTitle(title);
    setRewardsResults(results.map((result) => {
      const record = accounts.find((item) => (
        item.provider === result.provider && item.accountRef === result.accountRef
      ));
      return {
        ...result,
        displayName: record ? getAccountPrimaryLabel(record) : (result.accountRef || result.provider)
      };
    }));
    setRewardsOpen(true);
  };

  const showRewardsSummary = (job: AccountActivityJob) => {
    const summary = job.summary;
    if (summary && summary.claimed > 0) {
      message.success(`${job.actionLabel}：${summary.claimed} 个账号成功`);
    } else if (summary && summary.failed > 0) {
      message.warning(`${job.actionLabel}：${summary.failed} 个账号失败，详情见结果`);
    } else if (summary && summary.alreadyClaimed > 0) {
      message.info(`${job.actionLabel}：今天已经领过了`);
    } else {
      message.info(`${job.actionLabel}：当前没有可领取的活动`);
    }
  };

  const finishRewardsJob = (job: AccountActivityJob) => {
    setRewardsRunning(false);
    setRewardsJob(job);
    presentRewards(job.results || [], job.actionLabel);
    showRewardsSummary(job);
  };

  const pollRewardsJob = async (jobId: string) => {
    try {
      const response = await accountsAPI.getAccountActivityJob(jobId);
      const job = response.job;
      if (!job) throw new Error('领取任务不存在');
      if (isActivityJobTerminal(job.status)) {
        finishRewardsJob(job);
        return;
      }
      setRewardsJob(job);
      rewardsPollTimer.current = setTimeout(() => { void pollRewardsJob(jobId); }, 1000);
    } catch (error: any) {
      setRewardsRunning(false);
      setRewardsJob(null);
      message.error(error?.response?.data?.error || error?.message || '领取任务查询失败');
    }
  };

  // 只跑当前供应商 tab 里声明了该动作的账号（族内站点一起跑，如 Qoder 国际站 + 国内站）。
  // 开始请求立即返回 job，真正的领取在服务端后台串行执行，页面轮询进度。
  const runProviderRewards = async (action: AccountActivityAction, providers: string[]) => {
    if (rewardsRunning || providers.length === 0) return;
    if (rewardsPollTimer.current) {
      clearTimeout(rewardsPollTimer.current);
      rewardsPollTimer.current = null;
    }
    setRewardsRunning(true);
    setRewardsJob(null);
    try {
      const started = await accountsAPI.startAccountActivityJob({
        providers,
        actionId: action.id
      });
      if (!started.job) {
        throw new Error('服务端未返回领取任务，请重启 Server 后重试');
      }
      setRewardsJob(started.job);
      if (started.alreadyRunning) {
        message.info(`${action.label}：已有任务在跑，继续跟踪进度`);
      }
      void pollRewardsJob(started.job.id);
    } catch (error: any) {
      setRewardsRunning(false);
      message.error(error?.response?.data?.error || error?.message || `${action.label}失败`);
    }
  };

  const runOneReward = async (record: Account, actionId: string) => {
    if (rewardsRunning) return;
    const action = (record.activityActions || []).find((item) => item.id === actionId);
    if (rewardsPollTimer.current) {
      clearTimeout(rewardsPollTimer.current);
      rewardsPollTimer.current = null;
    }
    setRewardsJob(null);
    setRewardsRunning(true);
    try {
      const result = await accountsAPI.runAccountActivity(record.provider, record.accountRef, actionId);
      presentRewards([result], action?.label);
      if (result.status === 'claimed') {
        message.success(`${getAccountPrimaryLabel(record)}：${action?.label || '领取'}成功`);
      } else if (result.status === 'error') {
        message.warning(`${getAccountPrimaryLabel(record)}：${result.error || result.message || '领取失败'}`);
      }
    } catch (error: any) {
      message.error(error?.response?.data?.error || error?.message || '领取失败');
    } finally {
      setRewardsRunning(false);
    }
  };

  // 账号操作菜单（⋮）—— 列表列与卡片视图共用同一套 items + 点击分发，避免逻辑分叉。
  // 需要重新登录的账号只能重新登录（外加只读查看配置文件，便于排查凭据）：调度规则是第三方上游专属，
  // 登录态账号本来就没有入口。
  const buildAccountMenuItems = (record: Account): MenuProps['items'] => {
    if (requiresAccountReauth(record)) {
      return [
        { key: 'reauth', label: '重新登录', icon: <SyncOutlined /> },
        { key: 'config-files', label: '查看配置文件', icon: <FileSearchOutlined /> }
      ];
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
    menuItems.push({ key: 'config-files', label: '查看配置文件', icon: <FileSearchOutlined /> });
    if (canEditAccountRoutingRules(record)) {
      menuItems.push({ key: 'routing-rules', label: '编辑调度规则', icon: <CodeOutlined /> });
    }
    if (canRestoreAccountScheduling(record)) {
      menuItems.push({ key: 'restore-scheduling', label: '恢复调度', icon: <ReloadOutlined /> });
    }
    // 账号活动（签到 / 领臭鸡蛋）：动作来自服务端下发的 activityActions，
    // 前端不判断 provider（新增 provider 只加描述符）。
    for (const action of record.activityActions || []) {
      menuItems.push({
        key: `activity:${action.id}`,
        label: action.label,
        icon: <GiftOutlined />
      });
    }
    menuItems.push({ key: 'account-egress', label: '出口设置', icon: <GlobalOutlined /> });
    if (canConfigureWindowActivation(record)) {
      menuItems.push({ key: 'window-activation', label: '窗口激活', icon: <ClockCircleOutlined /> });
    }
    menuItems.push({ key: 'alias-pool', label: '别名选号', icon: <BranchesOutlined /> });
    menuItems.push({ key: 'model-context', label: '上下文窗口', icon: <FieldNumberOutlined /> });
    menuItems.push({ type: 'divider' });
    menuItems.push({ key: 'delete', label: '删除账号', danger: true, icon: <DeleteOutlined /> });
    return menuItems;
  };

  const handleAccountMenuClick = (record: Account, key: string) => {
    if (requiresAccountReauth(record) && key !== 'reauth' && key !== 'config-files') return;
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
    if (key === 'routing-rules') {
      if (canEditAccountRoutingRules(record)) handleRoutingRules(record);
      return;
    }
    if (key === 'restore-scheduling') { handleRestoreScheduling(record); return; }
    if (key.startsWith('activity:')) {
      void runOneReward(record, key.slice('activity:'.length));
      return;
    }
    if (key === 'account-egress') {
      setAccountEgressAccount(record);
      return;
    }
    if (key === 'window-activation') {
      setAccountWindowActivationAccount(record);
      return;
    }
    if (key === 'config-files') {
      setConfigFilesAccount(record);
      return;
    }
    if (key === 'alias-pool') {
      setAliasPoolAccount(record);
      return;
    }
    if (key === 'model-context') {
      setModelContextAccount(record);
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
      // 唯一弹性列承接大屏留白，其他列保持紧凑宽度。
      render: (_text: any, record: Account) => {
        const requiresReauth = requiresAccountReauth(record);
        const {
          desktopInstalled,
          desktopSupported,
          cliInstalled,
          cliSupported
        } = getAccountAppSupport(record, appEntries, appCapabilities, serverRuntime);
        const desktopEntryClassName = desktopInstalled
          ? undefined
          : 'account-client-entry-button--uninstalled';
        const cliEntryClassName = cliInstalled
          ? undefined
          : 'account-client-entry-button--uninstalled';
        const secondaryLabel = getAccountSecondaryLabel(record);

        return (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flexShrink: 0 }}>
            <AccountRefreshLogo
              account={record}
              activity={getAccountActivity(record)}
              refreshing={Boolean(refreshingAccountRefs[getAccountRef(record)])}
              onRefresh={handleRefreshAccount}
            />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="account-email-row" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 24 }}>
              <div style={{ fontWeight: 600, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {getAccountPrimaryLabel(record)}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <AccountHealthIcon
                  accountRef={getAccountRef(record)}
                  data={accountOutcomes.data}
                  unavailable={accountOutcomes.unavailable}
                />
                {/* 默认 / App 角色只由下方标签行表达（renderAccountRoleTags），此处不再重复图标 */}
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
            <AccountSubscriptionLines
              record={record}
              onConfirm={handleRefreshUsage}
              confirming={Boolean(refreshingUsageAccountRefs[getAccountRef(record)])}
            />
            {secondaryLabel ? (
              <Tooltip title={secondaryLabel}>
                <div className="account-secondary-label">
                  {secondaryLabel}
                </div>
              </Tooltip>
            ) : null}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
              {renderAccountRoleTags(record)}
              <Tag
                color={getPlanTagColor(record)}
                className="account-plan-tag"
                title={getPlanTagLabel(record)}
                style={{ fontSize: 11, lineHeight: '18px', padding: '0 4px', margin: 0 }}
              >
                {getPlanTagLabel(record)}
              </Tag>
              {renderAccountRegionTag(record)}
              {renderEgressBadge(record)}
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
                      if (serverRuntime) {
                        scheduleCliTerminalPicker(record);
                        return;
                      }
                      if (!cliInstalled) {
                        void handleOpenApp(record, 'cli');
                        return;
                      }
                      scheduleCliTerminalPicker(record);
                    }}
                    onDoubleClick={(event: any) => {
                      event?.stopPropagation?.();
                      if (serverRuntime) {
                        void accountActions.chooseCliTerminal(record);
                      } else if (cliInstalled) openCliWithDefaultTerminal(record);
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
      width: 80,
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
      title: '调度状态',
      dataIndex: 'schedulableStatus',
      key: 'schedulableStatus',
      width: 152,
      render: (_status: any, record: Account) => renderAccountDisplayBadge(record)
    },
    {
      title: '模型探测',
      key: 'modelProbe',
      width: 136,
      render: (_value: any, record: Account) => {
        const requiresReauth = requiresAccountReauth(record);
        const probe = getAccountModelProbe(record, modelCatalog);
        const modelRefreshing = Boolean(refreshingModelAccountRefs[getModelRefreshAccountRef(record)]);
        const tagLabel = getModelProbeTagLabel(probe, modelRefreshing, record.provider, record.status);
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
          </div>
        );
      }
    },
    {
      title: '剩余额度',
      dataIndex: 'remainingPct',
      key: 'remainingPct',
      width: 208,
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
        <div className="accounts-remaining-cell">
          <UsageProgressEffects record={record} activity={getAccountActivity(record)} drops={tokenDrops} />
        </div>
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
      width: 136,
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
      width: 144,
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

  const detectHostAccounts = async () => {
    setDetectingHostAccounts(true);
    try {
      const result = await accountsAPI.detectHostAccounts();
      const registered = result.updated || 0;
      const inventory = Object.entries(result.accounts || {})
        .filter(([, count]) => count > 0)
        .map(([provider, count]) => `${provider} ${count}`)
        .join('、');
      const summary = inventory ? `本机已入库：${inventory}` : '本机暂无可识别的已登录账号';
      if (registered > 0) {
        message.success(`扫描完成：新增/更新 ${registered} 个账号（${summary}）`);
        accountsSnapshot.requestAccountsSnapshotUpdate();
      } else {
        message.info(`扫描完成：没有新增账号（${summary}）`);
      }
    } catch {
      message.error('扫描本机账号失败');
    } finally {
      setDetectingHostAccounts(false);
    }
  };

  const getAccountExitClassName = React.useCallback((record: Account) => (
    removingAccountRefs[getAccountRef(record)]
      ? 'accounts-row-exiting animate__animated animate__fadeOutLeft animate__faster'
      : ''
  ), [removingAccountRefs]);

  const pendingIssueCount = countPendingIssues(activeStats);
  const unavailableCount = countUnavailable(activeStats);

  return (
    <PageScaffold ghost code="ACCOUNTS" className="accounts-page"
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
            key="detect"
            icon={<SyncOutlined />}
            loading={detectingHostAccounts}
            disabled={detectingHostAccounts}
            onClick={() => void detectHostAccounts()}
          >
            扫描本机账号
          </Button>
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
            value: `${activeStats.healthy} / ${activeStats.total}`,
            valueRender: (node) => <AnimatedValue changeKey={`${activeStats.healthy}/${activeStats.total}`}>{node}</AnimatedValue>
          }}
        />
        <StatisticCard
          className={pendingIssueCount > 0 ? 'accounts-stat--warning' : 'accounts-stat--accent'}
          statistic={{
            title: '待处理问题',
            value: pendingIssueCount,
            valueRender: (node) => <AnimatedValue changeKey={pendingIssueCount}>{node}</AnimatedValue>,
            description: `需登录 ${activeStats.reauthRequired} · 阻塞 ${activeStats.runtimeBlocked}`,
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
            valueRender: (node) => <AnimatedValue changeKey={unavailableCount}>{node}</AnimatedValue>,
            description: `耗尽 ${activeStats.exhausted} · 停池 ${activeStats.policyBlocked}`,
            valueStyle: {
              color: unavailableCount > 0
                ? 'var(--color-danger)'
                : undefined
            }
          }}
        />
      </StatisticCard.Group>

      <GlobalStatusPanel outcomes={accountOutcomes} />

      {hasActiveImportJob ? (
        <div className="accounts-import-running" role="status" aria-live="polite">
          <SyncOutlined spin aria-hidden="true" />
          <strong>账号导入正在后台运行</strong>
          <span>{formatImportJobProgress(importJob)}</span>
        </div>
      ) : null}

      <SectionCard
        title="账号列表"
        // 列表自动订阅快照；账号刷新统一由行首 Logo 触发。
        extra={
          <Space size={8}>
            <Button icon={<GlobalOutlined />} onClick={() => setBulkEgressOpen(true)}>
              批量设置出口
            </Button>
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
          </Space>
        }
      >
        {/* 卡片与列表共用筛选、视图切换；Provider 导航独占一行。 */}
        <Tabs
          className="accounts-provider-tabs"
          activeKey={activeProvider}
          onChange={(key) => setActiveProvider(key)}
          items={tabItems.map((tab) => ({ key: tab.key, label: tab.label }))}
        />
        {/* 卡片视图：供应商动作放在 tab 内容区顶部；列表视图把它并到“可用 n”同一行。 */}
        {viewMode === 'card' && (visibleActivityActions.length > 0 || rewardsProgressText) ? (
          <div className="accounts-activity-bar">
            {renderProviderActivityActions()}
          </div>
        ) : null}
        <div ref={viewBodyRef}>
        {viewMode === 'card' ? (
          <div className="aih-panel-enter" style={{ marginBottom: 16 }}>
            <AccountCardGrid
              accounts={filteredAccounts}
              provider={activeProvider as any}
              loading={loading}
              getActivity={getAccountActivity}
              onRefresh={handleRefreshAccount}
              isRefreshing={(record) => Boolean(refreshingAccountRefs[getAccountRef(record)])}
              renderHealth={(record) => (
                <AccountHealthIcon
                  accountRef={getAccountRef(record)}
                  data={accountOutcomes.data}
                  unavailable={accountOutcomes.unavailable}
                />
              )}
              renderUsage={(record) => (
                <UsageProgressEffects
                  record={record}
                  activity={getAccountActivity(record)}
                  drops={tokenDrops}
                />
              )}
              renderExtraTags={renderEgressBadge}
              getMenuItems={buildAccountMenuItems}
              onMenuClick={handleAccountMenuClick}
              onConfirmSubscription={handleRefreshUsage}
              isConfirmingSubscription={(record) => Boolean(refreshingUsageAccountRefs[getAccountRef(record)])}
              onCopy={copyAccountEmail}
              isDesktopSupported={(record) => Boolean(appEntries) && getAccountAppSupport(record, appEntries, appCapabilities, serverRuntime).desktopSupported}
              onOpenApp={(record) => {
                if (guardAccountLaunch(record, 'Desktop')) void handleOpenApp(record, 'desktop');
              }}
              onOpenCli={(record) => {
                if (!guardAccountLaunch(record, 'CLI')) return;
                if (serverRuntime) {
                  scheduleCliTerminalPicker(record);
                  return;
                }
                if (!appEntries?.[record.provider]?.cli) {
                  void handleOpenApp(record, 'cli');
                  return;
                }
                scheduleCliTerminalPicker(record);
              }}
            />
          </div>
        ) : (
          <div className="aih-panel-enter">
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
              toolBarRender={() => (
                visibleActivityActions.length > 0 || rewardsProgressText
                  ? [renderProviderActivityActions()]
                  : []
              )}
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
              tableLayout="fixed"
              scroll={{ x: 1462 }}
            />
          </div>
        )}
        </div>
      </SectionCard>

      <AccountFlowModals actions={accountActions} />
      <AccountEgressModal
        account={accountEgressAccount}
        onClose={() => {
          setAccountEgressAccount(null);
          void egressSummary.reload();
        }}
      />
      <AccountEgressBulkPicker
        open={bulkEgressOpen}
        view={egressSummary.view}
        providers={[...new Set(filteredAccounts.map((account) => account.provider))]}
        onClose={(changed) => {
          setBulkEgressOpen(false);
          if (changed) void egressSummary.reload();
        }}
      />
      <AccountWindowActivationModal
        account={accountWindowActivationAccount}
        onClose={() => setAccountWindowActivationAccount(null)}
      />
      <AccountConfigFilesModal
        account={configFilesAccount}
        onClose={() => setConfigFilesAccount(null)}
      />
      <AccountAliasPoolModal
        account={aliasPoolAccount}
        onClose={() => setAliasPoolAccount(null)}
      />
      <AccountModelContextModal
        account={modelContextAccount}
        models={modelContextAccount ? getAccountModelProbe(modelContextAccount, modelCatalog).models : []}
        onClose={() => setModelContextAccount(null)}
      />
      <AccountActivityModal
        open={rewardsOpen}
        title={rewardsTitle}
        results={rewardsResults}
        onClose={() => setRewardsOpen(false)}
      />
    </PageScaffold>
  );
};
