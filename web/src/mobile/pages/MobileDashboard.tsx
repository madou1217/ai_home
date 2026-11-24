import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, message } from 'antd';
import { DisconnectOutlined, ReloadOutlined } from '@ant-design/icons';
import { useGatewayDashboard, type DashboardLiveState } from '@/features/dashboard/use-gateway-dashboard';
import { usePresenceList } from '@/hooks/use-presence-list';
import {
  buildChatJumpPath,
  buildRuntimeParams,
  formatPercent,
  formatRecentErrorMessage,
  formatUptime,
  getOverallHealth,
  getOverallHealthMeta,
  getSuccessTone,
  resolveFriendlyAccountDisplay,
  sumRunningQueue,
  type ProviderRow
} from '@/features/dashboard/dashboard-presentation';
import MobileBoot from '@/mobile/MobileBoot';
import type { MobilePageProps } from '@/mobile/mobile-routes';
import {
  DetailSheet,
  EmptySignal,
  HudCard,
  HudIconButton,
  KeyValue,
  MobilePage,
  MobileToolbar,
  TelemetryGrid,
  TelemetryTile,
  type HudTone
} from '@/mobile/ui';
import { confirmAction } from '@/utils/confirm-action';
import { writeClipboardText } from '@/utils/clipboard';
import { HEALTH_TONE, SUCCESS_TONE } from './dashboard/dashboard-tones';
import {
  DashboardHotRoutesSection,
  DashboardProviderSection,
  DashboardRecentErrorsSection
} from './dashboard/DashboardSections';
import ProviderStatusSheet from './dashboard/ProviderStatusSheet';
import RecentErrorSheet, { type RecentErrorView } from './dashboard/RecentErrorSheet';
import styles from './MobileDashboard.module.css';

/** 管理快照通道状态（真实 watch / 回落读取），只做展示映射。 */
const LIVE_STATE: Record<DashboardLiveState, { text: string; tone: HudTone }> = {
  live: { text: '实时推送', tone: 'ok' },
  connecting: { text: '连接中', tone: 'info' },
  degraded: { text: '轮询模式', tone: 'warn' }
};

/**
 * 移动端网关仪表盘（/dashboard）。
 * 数据与操作全部来自 useGatewayDashboard（与桌面 Dashboard 同一数据层）：
 * managementAPI.watch / status / metrics / accounts / requestSnapshot / clearCooldown + accountsAPI.list。
 */
export default function MobileDashboard(_props: MobilePageProps) {
  const navigate = useNavigate();
  const {
    status,
    metrics,
    accountByRef,
    webuiAccountsLoaded,
    accountHealth,
    loading,
    loadError,
    cooldownClearing,
    liveState,
    displayedUptimeSec,
    providerRows,
    routeRows,
    recentErrors,
    handleClearCooldown,
    handleRefreshDashboard
  } = useGatewayDashboard();

  const [providerKey, setProviderKey] = useState<string | null>(null);
  const [providerOpen, setProviderOpen] = useState(false);
  // 错误详情在打开时定格（快照推送会重排列表，按下标取会串行）
  const [selectedError, setSelectedError] = useState<RecentErrorView | null>(null);
  const [errorOpen, setErrorOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [showIdleProviders, setShowIdleProviders] = useState(false);

  const totalAccounts = accountHealth.total;
  const healthyAccounts = accountHealth.healthy;
  const degradedCount = Math.max(0, totalAccounts - healthyAccounts);
  const healthPct = totalAccounts > 0 ? Math.round((healthyAccounts / totalAccounts) * 100) : 0;
  const overallHealth = getOverallHealth({
    statusLoaded: Boolean(status),
    accountsLoaded: webuiAccountsLoaded,
    total: totalAccounts,
    healthy: healthyAccounts
  });
  const health = getOverallHealthMeta(overallHealth, degradedCount);
  const healthTone = HEALTH_TONE[overallHealth];
  const heroTone = SUCCESS_TONE[getSuccessTone(status?.totalRequests, status?.successRate)];
  const totalRequestsCount = Number(metrics?.totalRequests || 0);
  const throughputTone = SUCCESS_TONE[getSuccessTone(totalRequestsCount, metrics?.successRate)];
  const totalQueueRunning = sumRunningQueue(status);
  const cooldownAccounts = Number(status?.cooldownAccounts || 0);
  const channel = LIVE_STATE[liveState];

  const activeProviders = providerRows.filter((row) => row.total > 0);
  const idleProviders = providerRows.filter((row) => row.total === 0);
  const selectedProvider = providerRows.find((row) => row.key === providerKey) || null;

  // 「未接入账号的 Provider」是列表里的条件行：收起时整组直接消失太硬。
  // 展开的新行本来就走 aih-fade-in 进场；收起改为离场保留 170ms 播完退出再移除。
  const providerListEntries = useMemo(
    () => providerRows
      .filter((row) => row.total > 0 || showIdleProviders)
      .map((row) => ({ row, idle: row.total === 0 })),
    [providerRows, showIdleProviders]
  );
  const providerPresence = usePresenceList(providerListEntries, (entry) => entry.row.key, 170);

  const errorViews = useMemo<RecentErrorView[]>(() => recentErrors.slice(0, 8).map((item, index) => ({
    key: `${item.at || 'unknown'}-${index}`,
    item,
    account: resolveFriendlyAccountDisplay(item, item.accountRef ? accountByRef.get(item.accountRef) : undefined),
    text: formatRecentErrorMessage(item)
  })), [accountByRef, recentErrors]);

  const onClearCooldown = async () => {
    const confirmed = await confirmAction({
      title: '清空冷却',
      content: '清空所有账号的冷却与运行时阻断状态，被调度层临时摘除的账号将重新参与调度。',
      okText: '清空',
      danger: true
    });
    if (confirmed) await handleClearCooldown();
  };

  const copyErrorText = async (text: string) => {
    try {
      await writeClipboardText(text);
      message.success('错误详情已复制到剪贴板');
    } catch (_err) {
      message.error('复制失败，请手动复制');
    }
  };

  const openChat = (options: { projectPath?: string; sessionId?: string }) => {
    setErrorOpen(false);
    navigate(buildChatJumpPath(options));
  };

  const openProvider = (row: ProviderRow) => {
    setProviderKey(row.key);
    setProviderOpen(true);
  };

  const openError = (view: RecentErrorView) => {
    setSelectedError(view);
    setErrorOpen(true);
  };

  const toolbar = (
    <MobileToolbar
      start={(
        <span className={styles.channel}>
          <span className="mhud-status">
            <span className={`hud-led hud-led--${channel.tone === 'muted' ? 'info' : channel.tone}${liveState === 'live' ? ' hud-led--live' : ''}`} />
            <span className={`mhud-tone--${channel.tone}`}>{channel.text}</span>
          </span>
        </span>
      )}
    >
      <HudIconButton
        icon={<DisconnectOutlined />}
        label="清空冷却"
        onClick={() => void onClearCooldown()}
        loading={cooldownClearing}
      />
      <HudIconButton
        icon={<ReloadOutlined />}
        label="刷新"
        tone="primary"
        onClick={() => void handleRefreshDashboard()}
        loading={loading}
      />
    </MobileToolbar>
  );

  if (!status) {
    return (
      <MobilePage
        toolbar={toolbar}
        lead="查看网关吞吐、账号健康与异常请求。"
      >
        {loadError && !loading ? (
          <EmptySignal
            title="连接失败"
            description={`加载管理面板失败：${loadError}`}
            action={<Button icon={<ReloadOutlined />} onClick={() => void handleRefreshDashboard()}>重试</Button>}
          />
        ) : (
          <MobileBoot label="同步网关状态" />
        )}
      </MobilePage>
    );
  }

  const runtimeParams = buildRuntimeParams(status, displayedUptimeSec);

  return (
    <MobilePage
      toolbar={toolbar}
      lead="查看网关吞吐、账号健康与异常请求。"
    >
      <TelemetryGrid>
        <TelemetryTile
          wide
          label="请求成功率"
          led
          tone={heroTone}
          value={Number(status.totalRequests || 0) > 0 ? formatPercent(status.successRate) : '—'}
          sub={Number(status.totalRequests || 0) > 0
            ? `${status.totalRequests} 请求 · 超时 ${formatPercent(status.timeoutRate)}`
            : '暂无请求'}
        />
        <TelemetryTile
          label="健康账号"
          led={overallHealth === 'loading' ? 'live' : true}
          tone={healthTone}
          value={healthyAccounts}
          unit={`/ ${totalAccounts}`}
          track={healthPct}
          sub={health.label}
        />
        <TelemetryTile
          label="冷却中账号"
          led
          tone={cooldownAccounts > 0 ? 'warn' : 'ok'}
          value={cooldownAccounts}
          sub={cooldownAccounts > 0 ? '调度层临时摘除' : '无冷却账号'}
        />
        <TelemetryTile
          label="累计请求"
          tone={throughputTone === 'muted' ? 'info' : throughputTone}
          value={totalRequestsCount.toLocaleString()}
          sub={totalRequestsCount > 0 ? `成功率 ${formatPercent(metrics?.successRate)}` : '暂无请求'}
        />
        <TelemetryTile
          label="并发运行中"
          led={totalQueueRunning > 0 ? 'live' : true}
          tone={totalQueueRunning > 10 ? 'warn' : 'ok'}
          value={totalQueueRunning}
          sub="活跃会话队列"
        />
        <TelemetryTile
          label="运行时长"
          tone="info"
          value={formatUptime(displayedUptimeSec)}
          sub={`后端 ${status.backend || 'Node'}`}
        />
        <TelemetryTile
          label="调度策略"
          tone="info"
          value={<span className={styles.textValue}>{status.strategy || '—'}</span>}
          sub={`模式 ${status.providerMode || '—'}`}
        />
      </TelemetryGrid>

      <DashboardProviderSection
        activeCount={activeProviders.length}
        totalCount={providerRows.length}
        idleCount={idleProviders.length}
        showIdleProviders={showIdleProviders}
        onToggleIdleProviders={() => setShowIdleProviders((value) => !value)}
        entries={providerPresence.render}
        onOpenProvider={openProvider}
        onGoAccounts={() => navigate('/accounts')}
      />

      <DashboardRecentErrorsSection
        errorViews={errorViews}
        onOpenError={openError}
        onCopyError={(text) => void copyErrorText(text)}
        onOpenChat={openChat}
      />

      <DashboardHotRoutesSection routeRows={routeRows} />

      <HudCard
        code="RUNTIME"
        title="服务运行参数"
        extra={<span className={styles.dim}>{`${status.host}:${status.port}`}</span>}
        onClick={() => setParamsOpen(true)}
        ariaLabel="查看服务运行参数"
      >
        <span className={styles.cardHint}>后端 {status.backend || '—'} · 缓存模型 {status.modelsCached || 0} · 点击查看</span>
      </HudCard>

      <ProviderStatusSheet open={providerOpen} row={selectedProvider} onClose={() => setProviderOpen(false)} />
      <RecentErrorSheet
        open={errorOpen}
        error={selectedError}
        onClose={() => setErrorOpen(false)}
        onCopy={(text) => void copyErrorText(text)}
        onOpenChat={openChat}
      />
      <DetailSheet open={paramsOpen} onClose={() => setParamsOpen(false)} code="RUNTIME" title="服务运行参数">
        <KeyValue rows={runtimeParams.map(([label, value]) => ({ key: label, label, value }))} />
      </DetailSheet>
    </MobilePage>
  );
}
