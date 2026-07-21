import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Alert, Grid, message } from 'antd';
import {
  DisconnectOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import { managementAPI } from '@/services/api';
import type { ManagementAccount, ManagementMetrics, ManagementStatus, Provider } from '@/types';
import ProviderIcon, { providerIds, providerNames } from '@/components/chat/ProviderIcon';
import RuntimeStatusTag from '@/components/runtime/RuntimeStatusTag';
import '../styles/unified.css';
import '@/components/mobile/mobile-cards.css';
import './Dashboard.css';

const PROVIDERS: Provider[] = providerIds;

const formatPercent = (value?: number) => `${(Number(value || 0) * 100).toFixed(1)}%`;

function normalizeQueueCount(value: unknown, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.floor(numeric));
}

function formatRecentErrorMessage(item: ManagementMetrics['lastErrors'][number]) {
  const msg = String(item?.message || item?.error || item?.detail || item?.reason || '').trim();
  if (msg) return msg;
  return '未提供错误详情';
}

type ProviderRow = {
  key: Provider;
  provider: Provider;
  total: number;
  active: number;
  statuses: Record<string, number>;
  queue: any;
  requests: number;
  success: number;
  failures: number;
};

function getRecentErrorProvider(item: ManagementMetrics['lastErrors'][number]) {
  const provider = String(item.provider || '').trim().toLowerCase();
  return PROVIDERS.includes(provider as Provider) ? (provider as Provider) : null;
}

function getRecentErrorAccountRef(item: ManagementMetrics['lastErrors'][number]) {
  return String(item.accountRef || '').trim();
}

export default function Dashboard() {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [status, setStatus] = useState<ManagementStatus | null>(null);
  const [metrics, setMetrics] = useState<ManagementMetrics | null>(null);
  const [accounts, setAccounts] = useState<ManagementAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const [cooldownClearing, setCooldownClearing] = useState(false);
  const [liveState, setLiveState] = useState<'connecting' | 'live' | 'degraded'>('connecting');
  const [statusReceivedAt, setStatusReceivedAt] = useState(0);
  const [uptimeTickMs, setUptimeTickMs] = useState(() => Date.now());
  const snapshotReceivedAtRef = useRef(0);
  const refreshFallbackTimerRef = useRef<number | null>(null);

  function clearRefreshFallbackTimer() {
    if (refreshFallbackTimerRef.current === null) return;
    window.clearTimeout(refreshFallbackTimerRef.current);
    refreshFallbackTimerRef.current = null;
  }

  function applyDashboardSnapshot(
    nextStatus: ManagementStatus,
    nextMetrics: ManagementMetrics,
    nextAccounts: ManagementAccount[]
  ) {
    const receivedAt = Date.now();
    snapshotReceivedAtRef.current = receivedAt;
    setStatus(nextStatus);
    setMetrics(nextMetrics);
    setAccounts(nextAccounts || []);
    setStatusReceivedAt(receivedAt);
    setLiveState('live');
    setLoading(false);
    clearRefreshFallbackTimer();
  }

  const loadDashboard = useCallback(async (options: { showLoading?: boolean; quietError?: boolean } = {}) => {
    const showLoading = Boolean(options.showLoading);
    const quietError = Boolean(options.quietError);
    if (showLoading) {
      setLoading(true);
    }
    try {
      const [nextStatus, nextMetrics, nextAccounts] = await Promise.all([
        managementAPI.status(),
        managementAPI.metrics(),
        managementAPI.accounts()
      ]);
      const receivedAt = Date.now();
      snapshotReceivedAtRef.current = receivedAt;
      setStatus(nextStatus);
      setMetrics(nextMetrics);
      setAccounts(nextAccounts.accounts || []);
      setStatusReceivedAt(receivedAt);
      setLiveState('degraded');
    } catch (error: any) {
      if (!quietError) {
        message.error(error?.response?.data?.message || error?.message || '加载管理面板失败');
      }
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    const initialFallbackTimer = window.setTimeout(() => {
      if (snapshotReceivedAtRef.current > 0) return;
      setLiveState('degraded');
      loadDashboard({ showLoading: true, quietError: true });
    }, 2500);
    const watcher = managementAPI.watch({
      onConnected: () => {
        setLiveState('connecting');
      },
      onSnapshot: ({ status: nextStatus, metrics: nextMetrics, accounts: nextAccounts }) => {
        applyDashboardSnapshot(nextStatus, nextMetrics, nextAccounts || []);
      },
      onError: () => {
        setLiveState('degraded');
        if (snapshotReceivedAtRef.current === 0) {
          loadDashboard({ showLoading: true, quietError: true });
        } else {
          setLoading(false);
        }
      }
    });
    return () => {
      window.clearTimeout(initialFallbackTimer);
      clearRefreshFallbackTimer();
      watcher.close();
    };
  }, [loadDashboard]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setUptimeTickMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const displayedUptimeSec = useMemo(() => {
    if (typeof status?.uptimeSec !== 'number') return null;
    if (!statusReceivedAt) return status.uptimeSec;
    return status.uptimeSec + Math.max(0, Math.floor((uptimeTickMs - statusReceivedAt) / 1000));
  }, [status?.uptimeSec, statusReceivedAt, uptimeTickMs]);

  const handleClearCooldown = async () => {
    setCooldownClearing(true);
    try {
      await managementAPI.clearCooldown();
      message.success('已清空冷却状态');
      if (liveState === 'degraded') {
        await loadDashboard({ showLoading: true, quietError: true });
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '清空冷却失败');
    } finally {
      setCooldownClearing(false);
    }
  };

  const handleRefreshDashboard = async () => {
    const previousSnapshotAt = snapshotReceivedAtRef.current;
    setLoading(true);
    clearRefreshFallbackTimer();

    if (liveState === 'live' || liveState === 'connecting') {
      try {
        await managementAPI.requestSnapshot();
        refreshFallbackTimerRef.current = window.setTimeout(() => {
          if (snapshotReceivedAtRef.current > previousSnapshotAt) return;
          setLiveState('degraded');
          loadDashboard({ showLoading: true, quietError: true });
        }, 2000);
        return;
      } catch (_error) {
        setLiveState('degraded');
      }
    }

    await loadDashboard({ showLoading: true });
  };

  const providerRows = useMemo<ProviderRow[]>(() => {
    return PROVIDERS.map((provider) => {
      const providerStatus = status?.providers?.[provider];
      const providerQueue = status?.queue?.[provider];
      return {
        key: provider,
        provider,
        total: providerStatus?.total || 0,
        active: providerStatus?.active || 0,
        statuses: providerStatus?.statuses || {},
        queue: providerQueue,
        requests: metrics?.providerCounts?.[provider] || 0,
        success: metrics?.providerSuccess?.[provider] || 0,
        failures: metrics?.providerFailures?.[provider] || 0
      };
    });
  }, [metrics, status]);

  const routeRows = useMemo(() => {
    return Object.entries(metrics?.routeCounts || {})
      .sort((left, right) => Number(right[1]) - Number(left[1]))
      .slice(0, 8)
      .map(([route, count]) => ({
        key: route,
        route,
        count: Number(count || 0)
      }));
  }, [metrics]);

  const degradedCount = Math.max(0, Number(status?.totalAccounts || 0) - Number(status?.activeAccounts || 0));
  const recentErrors = metrics?.lastErrors || [];
  const accountByRef = useMemo(() => {
    return new Map(
      accounts
        .filter((account) => account.accountRef)
        .map((account) => [String(account.accountRef || ''), account])
    );
  }, [accounts]);

  const recentErrorRows = recentErrors.slice(0, 8).map((item, index) => ({ ...item, __key: `${item.at || 'unknown'}-${index}` }));

  const routeTotalMax = Math.max(routeRows[0]?.count || 0, 1);

  // ── 健康计算(信息架构以「系统是否健康」为核心) ──
  const totalAccounts = Number(status?.totalAccounts || 0);
  const activeAccounts = Number(status?.activeAccounts || 0);
  const healthPct = totalAccounts > 0 ? Math.round((activeAccounts / totalAccounts) * 100) : 0;
  const overallHealth = !status
    ? 'loading'
    : degradedCount === 0
      ? 'healthy'
      : (activeAccounts === 0 ? 'critical' : 'degraded');
  const healthMeta: Record<string, { label: string; dot: string }> = {
    loading: { label: '连接中…', dot: 'idle' },
    healthy: { label: '运行正常', dot: 'ok' },
    degraded: { label: `${degradedCount} 个账号降级`, dot: 'warn' },
    critical: { label: '无健康账号', dot: 'crit' }
  };
  const health = healthMeta[overallHealth];
  const totalQueueRunning = PROVIDERS.reduce((sum, p) => sum + normalizeQueueCount(status?.queue?.[p]?.running), 0);
  const formatUptime = (sec?: number | null) => {
    if (typeof sec !== 'number' || !Number.isFinite(sec)) return '-';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec % 60}s`;
    return `${sec}s`;
  };

  const runtimeParams: Array<[string, React.ReactNode]> = [
    ['Backend', status?.backend || '-'],
    ['调度策略', status?.strategy || '-'],
    ['监听地址', status ? `${status.host}:${status.port}` : '-'],
    ['Provider 模式', status?.providerMode || '-'],
    ['API Key', status?.apiKeyConfigured ? '已配置' : '未配置'],
    ['Sticky Session', status?.sessionAffinity?.total || 0],
    ['缓存模型', status?.modelsCached || 0],
    ['运行时长', formatUptime(displayedUptimeSec)]
  ];

  const renderProviderCard = (row: ProviderRow) => {
    const pct = row.total > 0 ? Math.round((row.active / row.total) * 100) : 0;
    const running = normalizeQueueCount(row.queue?.running);
    const queued = normalizeQueueCount(row.queue?.queued);
    const conc = normalizeQueueCount(row.queue?.maxConcurrency, 1);
    const offline = row.total === 0;
    const statusEntries = Object.entries(row.statuses || {}).filter(([, c]) => Number(c) > 0);
    return (
      <div className={`dash-pcard${offline ? ' dash-pcard--offline' : ''}`} key={row.key}>
        <div className="dash-pcard-head">
          <ProviderIcon provider={row.provider} size={22} />
          <span className="dash-pcard-name">{providerNames[row.provider as keyof typeof providerNames] || row.provider}</span>
          <span className={`dash-pcard-ratio${pct < 100 && !offline ? ' warn' : ''}`}>{row.active}/{row.total}</span>
        </div>
        <div className="dash-bar">
          <span className={`dash-bar-fill${pct < 100 ? ' warn' : ''}`} style={{ width: `${offline ? 0 : pct}%` }} />
        </div>
        <div className="dash-pcard-stats">
          <span>队列 {running}/{queued}<i>并发 {conc}</i></span>
          <span>请求 {row.requests} · <b className="ok">✓{row.success}</b> · <b className="bad">✗{row.failures}</b></span>
        </div>
        {statusEntries.length > 0 ? (
          <div className="dash-pcard-tags">
            {statusEntries.map(([s, c]) => (
              <span key={s}><RuntimeStatusTag status={s} /> {c}</span>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <PageScaffold ghost
      className="dash-page"
      title="网关仪表盘"
      subTitle="展示本地 Server 调度、熔断、恢复和队列的真实运行态。"
      extra={isMobile ? (
        <div className="m-header-actions">
          <button className="m-icon-btn" aria-label="清空冷却" onClick={handleClearCooldown} disabled={cooldownClearing}><DisconnectOutlined /></button>
          <button className="m-icon-btn primary" aria-label="刷新" onClick={handleRefreshDashboard} disabled={loading}><ReloadOutlined spin={loading} /></button>
        </div>
      ) : [
        <Button key="clear" onClick={handleClearCooldown} loading={cooldownClearing}>
          清空冷却
        </Button>,
        <Button
          key="refresh"
          type="primary"
          icon={<ReloadOutlined />}
          onClick={handleRefreshDashboard}
          loading={loading}
        >
          刷新
        </Button>
      ]}
    >
      {/* ── Hero:系统健康一眼概览 ── */}
      <div className={`dash-hero dash-hero--${overallHealth}`}>
        <div className="dash-hero-head">
          <span className="dash-hero-status">
            <span className={`dash-dot dash-dot--${health.dot}`} />
            {health.label}
          </span>
          <span className="dash-hero-uptime">运行 {formatUptime(displayedUptimeSec)}</span>
        </div>
        <div className="dash-hero-body">
          <div className="dash-hero-metric">
            <div className="dash-hero-value">{Number(status?.totalRequests || 0) > 0 ? formatPercent(status?.successRate) : '—'}</div>
            <div className="dash-hero-cap">{Number(status?.totalRequests || 0) > 0 ? '请求成功率' : '暂无请求'}</div>
          </div>
          <div className="dash-hero-side">
            <div className="dash-hero-health">
              <div className="dash-hero-health-row">
                <span>健康账号</span>
                <span><b>{activeAccounts}</b> / {totalAccounts}</span>
              </div>
              <div className="dash-bar">
                <span className={`dash-bar-fill${healthPct < 100 ? ' warn' : ''}`} style={{ width: `${healthPct}%` }} />
              </div>
            </div>
            <div className="dash-hero-chips">
              <span className="dash-chip"><b>{status?.totalRequests || 0}</b> 请求</span>
              <span className="dash-chip"><b>{formatPercent(status?.timeoutRate)}</b> 超时</span>
              <span className="dash-chip"><b>{totalQueueRunning}</b> 运行中</span>
            </div>
          </div>
        </div>
      </div>

      {status?.cooldownAccounts ? (
        <Alert
          type="warning"
          showIcon
          className="dash-alert"
          message={`当前共有 ${status.cooldownAccounts} 个账号处于非健康态，已被调度层临时摘除。`}
        />
      ) : null}

      {/* ── Provider 运行状态:健康卡片(手机竖排、桌面网格) ── */}
      <div className="dash-block-title">Provider 运行状态</div>
      <div className="dash-provider-grid">
        {providerRows.map(renderProviderCard)}
      </div>

      {/* ── 最近错误:有才显示 ── */}
      {recentErrorRows.length > 0 ? (
        <>
          <div className="dash-block-title">最近错误<span className="dash-block-count">{recentErrorRows.length}</span></div>
          <div className="dash-error-list">
            {recentErrorRows.map((item) => {
              const provider = getRecentErrorProvider(item);
              const accountRef = getRecentErrorAccountRef(item);
              const account = accountRef ? accountByRef.get(accountRef) : undefined;
              return (
                <div className="dash-error-item" key={item.__key}>
                  <div className="dash-error-top">
                    <span className="dash-error-prov">
                      {provider ? <ProviderIcon provider={provider as Provider} size={15} /> : null}
                      {(account?.email || accountRef || (provider ? (providerNames[provider as keyof typeof providerNames] || provider) : '未知'))}
                    </span>
                    <span className="dash-error-time">{item.at ? new Date(item.at).toLocaleTimeString() : '-'}</span>
                  </div>
                  <div className="dash-error-msg">{formatRecentErrorMessage(item)}</div>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {/* ── 热点路由:有才显示,用占比条 ── */}
      {routeRows.length > 0 ? (
        <>
          <div className="dash-block-title">热点路由</div>
          <div className="dash-route-list">
            {routeRows.map((r) => (
              <div className="dash-route-item" key={r.key}>
                <div className="dash-route-line">
                  <span className="dash-route-name" title={r.route}>{r.route}</span>
                  <span className="dash-route-count">{r.count}</span>
                </div>
                <div className="dash-bar dash-bar--slim">
                  <span className="dash-bar-fill acc" style={{ width: `${Math.round((r.count / routeTotalMax) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {/* ── 运行参数:降级为可折叠紧凑区(静态配置、低频关注) ── */}
      <details className="dash-params">
        <summary>服务运行参数</summary>
        <div className="dash-params-grid">
          {runtimeParams.map(([k, v]) => (
            <div className="dash-param" key={k}>
              <span className="dash-param-k">{k}</span>
              <span className="dash-param-v">{v}</span>
            </div>
          ))}
        </div>
      </details>
    </PageScaffold>
  );
}
