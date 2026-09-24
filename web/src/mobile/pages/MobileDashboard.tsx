import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, message } from 'antd';
import {
  CopyOutlined,
  DisconnectOutlined,
  DownOutlined,
  MessageOutlined,
  ReloadOutlined,
  UpOutlined,
  WarningOutlined
} from '@ant-design/icons';
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import { useGatewayDashboard, type DashboardLiveState } from '@/features/dashboard/use-gateway-dashboard';
import {
  buildChatJumpPath,
  buildRuntimeParams,
  formatPercent,
  formatRecentErrorMessage,
  formatUptime,
  getOverallHealth,
  getOverallHealthMeta,
  getRecentErrorProvider,
  getSuccessTone,
  normalizeQueueCount,
  resolveFriendlyAccountDisplay,
  sumRunningQueue,
  type ProviderRow
} from '@/features/dashboard/dashboard-presentation';
import MobileBoot from '@/mobile/MobileBoot';
import type { MobilePageProps } from '@/mobile/mobile-routes';
import {
  DetailSheet,
  HudCard,
  HudIconButton,
  HudSection,
  KeyValue,
  MobilePage,
  MobileToolbar,
  MonoList,
  SwipeRow,
  TelemetryGrid,
  TelemetryTile,
  type HudTone,
  type SwipeAction
} from '@/mobile/ui';
import { confirmAction } from '@/utils/confirm-action';
import { HEALTH_TONE, SUCCESS_TONE } from './dashboard/dashboard-tones';
import ProviderStatusSheet from './dashboard/ProviderStatusSheet';
import RecentErrorSheet, { type RecentErrorView } from './dashboard/RecentErrorSheet';
import styles from './MobileDashboard.module.css';

/** 管理快照通道状态（真实 watch / 回落读取），只做展示映射。 */
const LIVE_STATE: Record<DashboardLiveState, { text: string; tone: HudTone }> = {
  live: { text: 'LIVE', tone: 'ok' },
  connecting: { text: 'SYNC', tone: 'info' },
  degraded: { text: 'POLL', tone: 'warn' }
};

const providerLabel = (provider: string) => providerNames[provider as keyof typeof providerNames] || provider;

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

  const errorViews = useMemo<RecentErrorView[]>(() => recentErrors.slice(0, 8).map((item, index) => ({
    key: `${item.at || 'unknown'}-${index}`,
    item,
    account: resolveFriendlyAccountDisplay(item, item.accountRef ? accountByRef.get(item.accountRef) : undefined),
    text: formatRecentErrorMessage(item)
  })), [accountByRef, recentErrors]);

  const routeTotalMax = Math.max(routeRows[0]?.count || 0, 1);

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
      await navigator.clipboard.writeText(text);
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

  const renderProviderRow = (row: ProviderRow) => {
    const pct = row.total > 0 ? Math.round((row.active / row.total) * 100) : 0;
    const offline = row.total === 0;
    const running = normalizeQueueCount(row.queue?.running);
    const queued = normalizeQueueCount(row.queue?.queued);
    const conc = normalizeQueueCount(row.queue?.maxConcurrency, 1);
    const ratioTone: HudTone = offline ? 'muted' : pct < 100 ? 'warn' : 'ok';
    return (
      <SwipeRow key={row.key} onTap={() => openProvider(row)} ariaLabel={`查看 ${providerLabel(row.provider)} 运行状态`}>
        <span className={`mhud-row__icon${offline ? ` ${styles.idle}` : ''}`}>
          <ProviderIcon provider={row.provider} size={20} />
        </span>
        <span className={`mhud-row__main${offline ? ` ${styles.idle}` : ''}`}>
          <span className="mhud-row__title">{providerLabel(row.provider)}</span>
          <span className="mhud-row__meta">队列 {running}/{queued} · 并发 {conc} · 请求 {row.requests}</span>
        </span>
        <span className="mhud-row__side">
          <span className={`${styles.ratio} mhud-tone--${ratioTone}`}>{row.active}/{row.total}</span>
          <span className={styles.counts}>
            <span className="mhud-tone--ok">✓{row.success}</span>
            <span className={row.failures > 0 ? 'mhud-tone--err' : styles.dim}>✗{row.failures}</span>
          </span>
        </span>
      </SwipeRow>
    );
  };

  const toolbar = (
    <MobileToolbar
      start={(
        <span className={styles.channel}>
          <span className="mhud-status">
            <span className={`hud-led hud-led--${channel.tone === 'muted' ? 'info' : channel.tone}${liveState === 'live' ? ' hud-led--live' : ''}`} />
            <span className={`mhud-tone--${channel.tone}`}>{channel.text}</span>
          </span>
          <span className={styles.channelHealth}>{health.label}</span>
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
      <MobilePage toolbar={toolbar}>
        {loadError && !loading ? (
          <div className={styles.loadError} role="alert">
            <span className="mhud-status mhud-tone--err">
              <span className="hud-led hud-led--err" />
              LINK DOWN
            </span>
            <span className={styles.loadErrorText}>加载管理面板失败：{loadError}</span>
            <Button icon={<ReloadOutlined />} onClick={() => void handleRefreshDashboard()}>重试</Button>
          </div>
        ) : (
          <MobileBoot label="SYNC" />
        )}
      </MobilePage>
    );
  }

  const runtimeParams = buildRuntimeParams(status, displayedUptimeSec);

  return (
    <MobilePage toolbar={toolbar}>
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
          label="冷却摘除"
          led
          tone={cooldownAccounts > 0 ? 'warn' : 'ok'}
          value={cooldownAccounts}
          sub={cooldownAccounts > 0 ? '已被调度层临时摘除' : '无摘除账号'}
        />
        <TelemetryTile
          label="总请求吞吐"
          tone={throughputTone === 'muted' ? 'info' : throughputTone}
          value={totalRequestsCount.toLocaleString()}
          sub={totalRequestsCount > 0 ? `成功率 ${formatPercent(metrics?.successRate)}` : '暂无请求'}
        />
        <TelemetryTile
          label="并发运行中"
          led={totalQueueRunning > 0 ? 'live' : true}
          tone={totalQueueRunning > 10 ? 'warn' : 'ok'}
          value={totalQueueRunning}
          sub="实时活跃 Session 队列"
        />
        <TelemetryTile
          label="运行时间"
          tone="info"
          value={formatUptime(displayedUptimeSec)}
          sub={`后端 ${status.backend || 'Node'}`}
        />
        <TelemetryTile
          label="调度策略"
          tone="info"
          value={<span className={styles.textValue}>{status.strategy || '-'}</span>}
          sub={`Provider 模式 ${status.providerMode || '-'}`}
        />
      </TelemetryGrid>

      <HudSection title="Provider 运行状态" code="PROV" count={`${activeProviders.length}/${providerRows.length}`}>
        <MonoList ariaLabel="Provider 运行状态">
          {activeProviders.map(renderProviderRow)}
          {showIdleProviders ? idleProviders.map(renderProviderRow) : null}
        </MonoList>
        {idleProviders.length > 0 ? (
          <button
            type="button"
            className={styles.expander}
            aria-expanded={showIdleProviders}
            onClick={() => setShowIdleProviders((value) => !value)}
          >
            {showIdleProviders ? <UpOutlined /> : <DownOutlined />}
            <span>{showIdleProviders ? '收起未接入账号的 Provider' : `显示未接入账号的 Provider（${idleProviders.length}）`}</span>
          </button>
        ) : null}
      </HudSection>

      {errorViews.length > 0 ? (
        <HudSection title="最近错误" code="ERR" count={errorViews.length}>
          <MonoList ariaLabel="最近错误">
            {errorViews.map((view) => {
              const provider = getRecentErrorProvider(view.item);
              const canOpenChat = Boolean(view.item.projectPath || view.item.sessionId);
              const actions: SwipeAction[] = [
                { key: 'copy', label: '复制', icon: <CopyOutlined />, onAction: () => void copyErrorText(view.text) }
              ];
              if (canOpenChat) {
                actions.push({
                  key: 'chat',
                  label: '会话',
                  icon: <MessageOutlined />,
                  tone: 'primary',
                  onAction: () => openChat({ projectPath: view.item.projectPath, sessionId: view.item.sessionId })
                });
              }
              return (
                <SwipeRow key={view.key} actions={actions} onTap={() => openError(view)} ariaLabel={`查看错误详情：${view.account}`}>
                  <span className="mhud-row__icon">
                    {provider ? <ProviderIcon provider={provider} size={18} /> : <WarningOutlined className="mhud-tone--err" />}
                  </span>
                  <span className="mhud-row__main">
                    <span className="mhud-row__title">{view.account}</span>
                    <span className={`mhud-row__meta ${styles.errorMeta}`}>{view.text}</span>
                  </span>
                  <span className="mhud-row__side">
                    <span className="mhud-status mhud-tone--err">
                      <span className="hud-led hud-led--err" />
                      ERR
                    </span>
                    {view.item.at ? <span className={styles.dim}>{new Date(view.item.at).toLocaleTimeString()}</span> : null}
                  </span>
                </SwipeRow>
              );
            })}
          </MonoList>
        </HudSection>
      ) : null}

      {routeRows.length > 0 ? (
        <HudSection title="热点路由" code="ROUTE" count={routeRows.length}>
          <HudCard>
            <div className={styles.routeList}>
              {routeRows.map((row) => (
                <div className={styles.routeItem} key={row.key}>
                  <div className={styles.routeLine}>
                    <span className={styles.routeName}>{row.route}</span>
                    <span className={styles.routeCount}>{row.count}</span>
                  </div>
                  <span className="mhud-track" aria-hidden="true">
                    <span className="mhud-track__fill mhud-bg--info" style={{ width: `${Math.round((row.count / routeTotalMax) * 100)}%` }} />
                  </span>
                </div>
              ))}
            </div>
          </HudCard>
        </HudSection>
      ) : null}

      <HudCard
        code="RUNTIME"
        title="服务运行参数"
        extra={<span className={styles.dim}>{`${status.host}:${status.port}`}</span>}
        onClick={() => setParamsOpen(true)}
        ariaLabel="查看服务运行参数"
      >
        <span className={styles.cardHint}>Backend {status.backend || '-'} · 缓存模型 {status.modelsCached || 0} · 点按展开</span>
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
