import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Checkbox, Modal, Spin, Switch, Tooltip, message } from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  DesktopOutlined,
  ExclamationCircleOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  StopOutlined,
  SyncOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import {
  appDeskAPI,
  describeAppDeskError,
  extractAppDeskError,
  extractProxyPort,
  sanitizeProxyUrl,
  type AppDeskInstance,
  type AppDeskProxyStatus,
  type AppDeskView
} from './app-desk-api';
import './AppDeskPanel.css';

const POLL_INTERVAL_MS = 1500;
const CLOCK_TICK_MS = 1000;
const RECONNECT_ANIMATION_MS = 3400;
const FEEDBACK_TTL_MS = 6000;
const SAMPLE_COMMAND = 'aih app "Google Chrome" --proxy';

type ProxyVisualState = 'active' | 'reconnecting' | 'stopped';

interface ReconnectBanner {
  seq: number;
  leaseName: string;
}

interface ActionFeedback {
  id: number;
  tone: 'success' | 'error' | 'info';
  text: string;
  detail?: string;
}

function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.floor(ms / 1000));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return `${hours}h${String(remMinutes).padStart(2, '0')}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d${String(remHours).padStart(2, '0')}h`;
}

function formatClock(ms?: number): string {
  if (!ms || ms <= 0) return '—';
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDateTime(ms?: number): string {
  if (!ms || ms <= 0) return '—';
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatRelativeAgo(ms: number | undefined, nowMs: number): string {
  if (!ms || ms <= 0) return '';
  const diffSec = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (diffSec < 3) return '刚刚';
  if (diffSec < 60) return `${diffSec} 秒前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  return `${Math.floor(diffHour / 24)} 天前`;
}

function resolveProxyVisualState(proxy?: AppDeskProxyStatus, proxyError?: string): ProxyVisualState {
  if (!proxy || !proxy.running || proxyError) return 'stopped';
  return proxy.leaseActive ? 'active' : 'reconnecting';
}

function statusMeta(instance: AppDeskInstance): { tone: 'running' | 'starting' | 'exited' | 'unknown'; label: string } {
  switch (instance.status) {
    case 'running':
      return { tone: 'running', label: '运行中' };
    case 'starting':
      return { tone: 'starting', label: '启动中' };
    case 'exited':
      return { tone: 'exited', label: '已退出' };
    default:
      if (instance.live) return { tone: 'running', label: '运行中' };
      return { tone: 'unknown', label: '未知' };
  }
}

function proxyModeMeta(mode?: string): { label: string; tone: 'reliable' | 'best-effort' | 'neutral'; tip?: string } {
  switch ((mode || '').trim().toLowerCase()) {
    case 'chromium':
      return {
        label: '浏览器参数',
        tone: 'reliable',
        tip: '通过独立 profile 与 --proxy-server 参数挂代理（可靠生效）'
      };
    case 'environment':
      return {
        label: '环境变量',
        tone: 'best-effort',
        tip: '通过 HTTP(S)_PROXY 环境变量注入；若应用自身忽略环境变量则代理不生效'
      };
    default:
      return {
        label: mode || '代理',
        tone: 'neutral'
      };
  }
}

function formatPids(pids?: number[]): { display: string; full: string } {
  if (!pids || pids.length === 0) return { display: '—', full: '' };
  const full = pids.join(', ');
  if (pids.length <= 2) return { display: full, full };
  return {
    display: `${pids[0]}, ${pids[1]} +${pids.length - 2}`,
    full
  };
}

/** 轻量环形进度 SVG：用于续约按钮与代理状态卡。 */
function RingSpinner({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      className={`app-desk-ring-spinner${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 18 18"
      aria-hidden="true"
    >
      <circle className="app-desk-ring-track" cx="9" cy="9" r="7" />
      <circle className="app-desk-ring-arc" cx="9" cy="9" r="7" />
    </svg>
  );
}

/** 勾选绘制动画 SVG：用于“上游已重连”与操作成功提示。 */
function AnimatedCheck({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="app-desk-check-svg"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <circle className="app-desk-check-circle" cx="8" cy="8" r="6.5" />
      <path className="app-desk-check-tick" d="M4.8 8.2 L7.1 10.4 L11.4 5.8" />
    </svg>
  );
}

/**
 * 应用看台（Toolkit → 应用与集成）：
 * 展示通过 `aih app` 与 WebUI 启动的本机应用实例、实时进程/代理状态，
 * 并提供代理续约、热替换切换与进程结束控制。
 */
export default function AppDeskPanel() {
  const [desk, setDesk] = useState<AppDeskView | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [renewing, setRenewing] = useState(false);
  const [killingMode, setKillingMode] = useState<'' | 'selected' | 'all'>('');
  const [togglingHotSwap, setTogglingHotSwap] = useState(false);
  const [confirmKillAllOpen, setConfirmKillAllOpen] = useState(false);
  const [copiedSample, setCopiedSample] = useState(false);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [reconnectBanner, setReconnectBanner] = useState<ReconnectBanner | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);

  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const proxyPrevRef = useRef<{ initialized: boolean; leaseActive: boolean; reconnects: number }>({
    initialized: false,
    leaseActive: false,
    reconnects: 0
  });
  const reconnectTimerRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const seqRef = useRef(0);

  const showFeedback = useCallback((tone: ActionFeedback['tone'], text: string, detail?: string) => {
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    seqRef.current += 1;
    setFeedback({ id: seqRef.current, tone, text, detail });
    feedbackTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setFeedback(null);
      feedbackTimerRef.current = null;
    }, FEEDBACK_TTL_MS);
  }, []);

  const triggerReconnectCue = useCallback((leaseName?: string) => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
    }
    seqRef.current += 1;
    setReconnectBanner({
      seq: seqRef.current,
      leaseName: (leaseName || '').trim()
    });
    reconnectTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setReconnectBanner(null);
      reconnectTimerRef.current = null;
    }, RECONNECT_ANIMATION_MS);
  }, []);

  const observeProxyTransition = useCallback((proxy: AppDeskProxyStatus) => {
    const nextReconnects = proxy.reconnects ?? 0;
    const prev = proxyPrevRef.current;
    if (prev.initialized) {
      const recoveredLease = !prev.leaseActive && proxy.leaseActive;
      const bumpedReconnects = nextReconnects > prev.reconnects;
      if (recoveredLease || bumpedReconnects) {
        triggerReconnectCue(proxy.leaseName);
      }
    }
    proxyPrevRef.current = {
      initialized: true,
      leaseActive: proxy.leaseActive,
      reconnects: nextReconnects
    };
  }, [triggerReconnectCue]);

  const applyDeskSnapshot = useCallback((next: AppDeskView) => {
    observeProxyTransition(next.proxy);
    setDesk(next);
    setLoadError('');
    setSelectedIds((current) => {
      if (current.length === 0) return current;
      const valid = new Set(next.instances.map((item) => item.id));
      const filtered = current.filter((id) => valid.has(id));
      return filtered.length === current.length ? current : filtered;
    });
  }, [observeProxyTransition]);

  const fetchDesk = useCallback(async (options?: { manual?: boolean }) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (options?.manual) setManualRefreshing(true);
    try {
      const next = await appDeskAPI.getDesk();
      if (!mountedRef.current) return;
      applyDeskSnapshot(next);
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      setLoadError(describeAppDeskError(error, '读取应用看台失败'));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
        if (options?.manual) setManualRefreshing(false);
      }
    }
  }, [applyDeskSnapshot]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchDesk();
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, [fetchDesk]);

  // 每 1.5s 轮询看台快照；页面隐藏时暂停，切回可见时立即拉一次。
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchDesk();
      }
    }, POLL_INTERVAL_MS);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void fetchDesk();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchDesk]);

  // 本地 1s 时钟：平滑更新运行时长与“最后续约”相对时间。
  useEffect(() => {
    const ticker = window.setInterval(() => {
      setNowMs(Date.now());
    }, CLOCK_TICK_MS);
    return () => window.clearInterval(ticker);
  }, []);

  const instances = desk?.instances ?? [];
  const proxy = desk?.proxy;
  const proxyState = resolveProxyVisualState(proxy, desk?.proxyError);
  const hotSwapEnabled = desk?.hotSwap ?? false;
  const hotSwapUnavailable = Boolean(proxy?.running && !proxy.hotSwapAvailable);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedInstances = useMemo(
    () => instances.filter((item) => selectedSet.has(item.id)),
    [instances, selectedSet]
  );
  const liveInstances = useMemo(
    () => instances.filter((item) => item.live),
    [instances]
  );
  const selectedLiveIds = useMemo(
    () => selectedInstances.filter((item) => item.live).map((item) => item.id),
    [selectedInstances]
  );
  const selectedProxiedCount = useMemo(
    () => selectedInstances.filter((item) => item.proxied).length,
    [selectedInstances]
  );

  const allSelected = instances.length > 0 && selectedIds.length === instances.length;
  const someSelected = selectedIds.length > 0 && selectedIds.length < instances.length;
  const busyAny = renewing || Boolean(killingMode);
  const canRenew = selectedProxiedCount > 0 && !busyAny;

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(checked ? instances.map((item) => item.id) : []);
  };

  const toggleSelectOne = (id: string, checked?: boolean) => {
    setSelectedIds((current) => {
      const exists = current.includes(id);
      const nextChecked = typeof checked === 'boolean' ? checked : !exists;
      if (nextChecked && !exists) return [...current, id];
      if (!nextChecked && exists) return current.filter((item) => item !== id);
      return current;
    });
  };

  const handleRenew = async () => {
    if (!canRenew) return;
    setRenewing(true);
    const startedAt = Date.now();
    const prevReconnects = proxy?.reconnects ?? 0;
    try {
      const result = await appDeskAPI.renew(selectedIds);
      if (!mountedRef.current) return;
      const elapsedMs = Math.max(1, Date.now() - startedAt);
      observeProxyTransition(result.proxy);
      setDesk((current) => (current ? { ...current, proxy: result.proxy, proxyError: undefined } : current));
      const leaseTarget = result.proxy.leaseName || '当前出口';
      const reconnected = (result.proxy.reconnects ?? 0) > prevReconnects;
      const summary = reconnected
        ? `已重连上游 · ${leaseTarget}`
        : `已续约代理 · ${leaseTarget}`;
      showFeedback('success', summary, `${elapsedMs}ms`);
      message.success(`${summary}（${elapsedMs}ms）`);
      void fetchDesk();
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      const info = extractAppDeskError(error, '续约失败');
      if (info.proxy) {
        observeProxyTransition(info.proxy);
        setDesk((current) => (current ? { ...current, proxy: info.proxy! } : current));
      }
      showFeedback('error', `续约失败：${info.message}`);
      message.error(`续约失败：${info.message}`);
    } finally {
      if (mountedRef.current) setRenewing(false);
    }
  };

  const handleKillSelected = async () => {
    if (selectedLiveIds.length === 0 || busyAny) return;
    setKillingMode('selected');
    try {
      const result = await appDeskAPI.kill(selectedLiveIds);
      if (!mountedRef.current) return;
      if (result.desk) {
        applyDeskSnapshot(result.desk);
      } else {
        void fetchDesk();
      }
      const killedCount = result.results.filter((item) => item.killed).length;
      const failedItems = result.results.filter((item) => !item.killed && item.message && item.message !== '进程已退出');
      setSelectedIds((current) => current.filter((id) => !selectedLiveIds.includes(id)));
      if (failedItems.length > 0) {
        const reason = failedItems.map((item) => `${item.name}: ${item.message}`).join('；');
        showFeedback('error', `已结束 ${killedCount} 个实例，${failedItems.length} 个失败`, reason);
        message.warning(`已结束 ${killedCount} 个实例，部分失败：${reason}`);
      } else {
        showFeedback('success', `已结束 ${killedCount} 个选中实例`);
        message.success(`已结束 ${killedCount} 个选中实例`);
      }
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      const text = describeAppDeskError(error, '结束选中实例失败');
      showFeedback('error', `结束失败：${text}`);
      message.error(text);
    } finally {
      if (mountedRef.current) setKillingMode('');
    }
  };

  const handleKillAllConfirm = async () => {
    if (busyAny) return;
    setKillingMode('all');
    try {
      const result = await appDeskAPI.kill([]);
      if (!mountedRef.current) return;
      setConfirmKillAllOpen(false);
      setSelectedIds([]);
      if (result.desk) {
        applyDeskSnapshot(result.desk);
      } else {
        void fetchDesk();
      }
      const killedCount = result.results.filter((item) => item.killed).length;
      const failedItems = result.results.filter((item) => !item.killed && item.message && item.message !== '进程已退出');
      if (failedItems.length > 0) {
        const reason = failedItems.map((item) => `${item.name}: ${item.message}`).join('；');
        showFeedback('error', `已结束 ${killedCount} 个实例，${failedItems.length} 个失败`, reason);
        message.warning(`已结束 ${killedCount} 个实例，部分失败：${reason}`);
      } else {
        showFeedback('success', killedCount > 0 ? `已结束全部 ${killedCount} 个运行实例` : '当前没有可结束的运行实例');
        message.success(killedCount > 0 ? `已结束全部 ${killedCount} 个运行实例` : '当前没有可结束的运行实例');
      }
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      const text = describeAppDeskError(error, '结束全部实例失败');
      showFeedback('error', `结束全部失败：${text}`);
      message.error(text);
    } finally {
      if (mountedRef.current) setKillingMode('');
    }
  };

  const handleToggleHotSwap = async (nextEnabled: boolean) => {
    if (togglingHotSwap || hotSwapUnavailable) return;
    setTogglingHotSwap(true);
    try {
      const result = await appDeskAPI.setHotSwap(nextEnabled);
      if (!mountedRef.current) return;
      if (result.proxy) {
        observeProxyTransition(result.proxy);
      }
      setDesk((current) => {
        if (!current) return current;
        return {
          ...current,
          hotSwap: result.hotSwap,
          proxy: result.proxy ?? { ...current.proxy, hotSwap: result.hotSwap }
        };
      });
      const detail = result.running === false
        ? '代理入口未运行，已保存为下次启动默认配置'
        : result.hotSwap
          ? '原地替换上游并自动重试当前失败请求'
          : '恢复为重建入口模式（切换时将短暂断线）';
      showFeedback('info', result.hotSwap ? '上游热替换已开启' : '上游热替换已关闭', detail);
      message.success(result.hotSwap ? '上游热替换已开启' : '上游热替换已关闭');
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      const info = extractAppDeskError(error, '切换热替换失败');
      if (info.proxy) {
        observeProxyTransition(info.proxy);
        setDesk((current) => (current ? { ...current, proxy: info.proxy!, hotSwap: info.proxy!.hotSwap } : current));
      }
      showFeedback('error', `热替换切换失败：${info.message}`);
      message.error(info.message);
    } finally {
      if (mountedRef.current) setTogglingHotSwap(false);
    }
  };

  const handleCopySample = async () => {
    try {
      await navigator.clipboard.writeText(SAMPLE_COMMAND);
      setCopiedSample(true);
      message.success('已复制启动命令');
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) setCopiedSample(false);
        copyTimerRef.current = null;
      }, 2000);
    } catch {
      message.warning('剪贴板不可用，请手动复制命令');
    }
  };

  const renewDisabledTip = selectedIds.length === 0
    ? '请先勾选至少一个带代理的应用实例'
    : selectedProxiedCount === 0
      ? '已选实例均未启用代理，无法续约'
      : '';

  const killSelectedDisabledTip = selectedIds.length === 0
    ? '请先勾选要结束的运行实例'
    : selectedLiveIds.length === 0
      ? '已选实例均已退出'
      : '';

  const httpPort = extractProxyPort(proxy?.httpUrl);
  const socksPort = extractProxyPort(proxy?.socks5Url);
  const lastRenewAgo = formatRelativeAgo(proxy?.lastRenewAtMs, nowMs);
  const adoptedLiveCount = liveInstances.filter((item) => item.adopted).length;

  return (
    <section className="toolkit-page toolkit-domain-panel app-desk" aria-labelledby="toolkit-app-desk">
      <header className="toolkit-panel-header app-desk-header">
        <div>
          <div className="toolkit-panel-kicker">APP DESK</div>
          <h2 id="toolkit-app-desk">应用看台</h2>
          <p>
            实时跟踪通过 <code>aih app</code> 或 WebUI 启动的本机应用实例，统一管理进程状态、代理续约与上游热替换。
          </p>
        </div>
        <div className="app-desk-header-actions">
          <span className="app-desk-poll-pill" title="页面可见时每 1.5 秒自动轮询看台快照">
            <span className="app-desk-poll-dot" aria-hidden="true" />
            <span>1.5s 轮询</span>
          </span>
          <Button
            icon={<ReloadOutlined spin={manualRefreshing} />}
            loading={manualRefreshing}
            onClick={() => void fetchDesk({ manual: true })}
          >
            刷新
          </Button>
        </div>
      </header>

      {loadError ? (
        <InlineNote
          tone="error"
          action={
            <Button size="small" type="text" onClick={() => void fetchDesk({ manual: true })}>
              重试
            </Button>
          }
        >
          看台状态获取失败：{loadError}
        </InlineNote>
      ) : null}

      {/* 代理状态卡：完整描边 + 状态点 + 热替换开关，无左侧粗竖条、无大块 Alert */}
      <article
        className="app-desk-proxy-card"
        data-proxy-state={proxyState}
        data-renewing={renewing ? 'true' : 'false'}
        data-reconnected={reconnectBanner ? 'true' : 'false'}
        aria-label="代理入口状态"
      >
        {reconnectBanner ? (
          <div key={reconnectBanner.seq} className="app-desk-proxy-scan" aria-hidden="true" />
        ) : null}

        <div className="app-desk-proxy-top">
          <div className="app-desk-proxy-status-group">
            <span
              className="app-desk-proxy-orb"
              data-state={proxyState}
              data-pulse={reconnectBanner ? 'true' : 'false'}
              aria-hidden="true"
            >
              {renewing ? (
                <RingSpinner size={16} />
              ) : (
                <>
                  <span className="app-desk-proxy-orb-core" />
                  {reconnectBanner ? (
                    <span key={reconnectBanner.seq} className="app-desk-proxy-orb-wave" />
                  ) : null}
                </>
              )}
            </span>

            <div className="app-desk-proxy-title-block">
              <div className="app-desk-proxy-title-row">
                <h3>本机代理入口</h3>
                <span className="app-desk-state-pill" data-tone={proxy?.running && !desk?.proxyError ? 'running' : 'stopped'}>
                  {proxy?.running && !desk?.proxyError ? '运行中' : '未运行'}
                </span>
                {proxy?.running && !desk?.proxyError ? (
                  <span className="app-desk-state-pill" data-tone={proxy.leaseActive ? 'active' : 'reconnecting'}>
                    {proxy.leaseActive ? '租约活跃' : '正在重连'}
                  </span>
                ) : null}
                {renewing ? (
                  <span className="app-desk-renew-pill" role="status">
                    <RingSpinner size={12} />
                    <span>正在续约上游…</span>
                  </span>
                ) : null}
                {reconnectBanner ? (
                  <span key={reconnectBanner.seq} className="app-desk-reconnected-pill" role="status">
                    <AnimatedCheck size={13} />
                    <span>
                      上游已重连{reconnectBanner.leaseName ? ` · ${reconnectBanner.leaseName}` : ''}
                    </span>
                  </span>
                ) : null}
              </div>
              {proxyState === 'stopped' ? (
                <p className="app-desk-proxy-sub">
                  本机代理入口尚未启动；可在「网络 → 本机代理」启动或运行 <code>aih proxy serve</code>。
                </p>
              ) : null}
            </div>
          </div>

          {proxy?.running && !desk?.proxyError ? (
            <div className="app-desk-proxy-endpoints">
              {httpPort ? (
                <Tooltip title={sanitizeProxyUrl(proxy.httpUrl)}>
                  <span className="app-desk-endpoint-chip">HTTP :{httpPort}</span>
                </Tooltip>
              ) : null}
              {socksPort ? (
                <Tooltip title={sanitizeProxyUrl(proxy.socks5Url)}>
                  <span className="app-desk-endpoint-chip">SOCKS5 :{socksPort}</span>
                </Tooltip>
              ) : null}
              {proxy.pid ? <span className="app-desk-endpoint-chip">PID {proxy.pid}</span> : null}
            </div>
          ) : null}
        </div>

        <dl className="app-desk-proxy-metrics">
          <div className="app-desk-metric">
            <dt>出口名称</dt>
            <dd title={proxy?.leaseName || undefined}>
              <strong className="app-desk-metric-value">{proxy?.leaseName || '—'}</strong>
            </dd>
          </div>
          <div className="app-desk-metric">
            <dt>最后续约</dt>
            <dd title={proxy?.lastRenewAtMs ? formatDateTime(proxy.lastRenewAtMs) : undefined}>
              <strong className="app-desk-metric-value">
                {proxy?.lastRenewAtMs ? formatClock(proxy.lastRenewAtMs) : '尚未续约'}
              </strong>
              {lastRenewAgo ? <span className="app-desk-metric-sub">{lastRenewAgo}</span> : null}
            </dd>
          </div>
          <div className="app-desk-metric">
            <dt>重连次数</dt>
            <dd>
              <strong
                className="app-desk-metric-value"
                data-highlight={reconnectBanner ? 'true' : 'false'}
              >
                {proxy?.reconnects ?? 0}
              </strong>
              <span className="app-desk-metric-sub">次</span>
            </dd>
          </div>
          <div className="app-desk-metric">
            <dt>热替换状态</dt>
            <dd>
              <strong className="app-desk-metric-value">
                {hotSwapUnavailable
                  ? '不可用'
                  : hotSwapEnabled
                    ? '已开启'
                    : '已关闭'}
              </strong>
              <span className="app-desk-metric-sub">
                {hotSwapUnavailable
                  ? '需匿名且非 TUN'
                  : hotSwapEnabled
                    ? '原地替换并重试'
                    : '重建入口'}
              </span>
            </dd>
          </div>
        </dl>

        <div className="app-desk-hotswap-row">
          <div className="app-desk-hotswap-control">
            <label className="app-desk-hotswap-label" htmlFor="app-desk-hotswap-switch">
              <ThunderboltOutlined className="app-desk-hotswap-icon" />
              <span>上游热替换</span>
            </label>
            <Switch
              id="app-desk-hotswap-switch"
              size="small"
              checked={hotSwapEnabled && !hotSwapUnavailable}
              loading={togglingHotSwap}
              disabled={hotSwapUnavailable || togglingHotSwap}
              onChange={(checked) => void handleToggleHotSwap(checked)}
            />
          </div>
          <p className="app-desk-hotswap-desc" data-unavailable={hotSwapUnavailable ? 'true' : 'false'}>
            {hotSwapUnavailable
              ? '当前入口不支持热替换（需要匿名入口且非 TUN 模式；带认证 URL 内嵌租约凭据，切换上游会导致旧客户端凭据失效）。'
              : hotSwapEnabled
                ? '已开启：租约失效或续约切换时，原地替换上游并自动重试当前失败请求。'
                : '默认关闭：租约失效时重建本地代理入口（短暂断线）；开启后将原地替换上游并自动重试当前失败请求。'}
          </p>
        </div>

        {proxy?.running && proxy.lastError ? (
          <div className="app-desk-proxy-note">
            <InlineNote tone="warning">代理入口最近报错：{proxy.lastError}</InlineNote>
          </div>
        ) : null}
      </article>

      {/* 批量选择与操作工具条 */}
      <div className="app-desk-toolbar">
        <div className="app-desk-selection-bar">
          <Checkbox
            checked={allSelected}
            indeterminate={someSelected}
            disabled={instances.length === 0}
            onChange={(event) => toggleSelectAll(event.target.checked)}
          >
            全选
          </Checkbox>
          <span className="app-desk-selection-summary">
            {selectedIds.length > 0
              ? `已选 ${selectedIds.length} / ${instances.length}（含代理 ${selectedProxiedCount}）`
              : `共 ${instances.length} 个实例 · ${liveInstances.length} 运行中`}
          </span>
        </div>

        <div className="app-desk-actions">
          <Tooltip title={renewDisabledTip || undefined}>
            <span>
              <Button
                type="primary"
                icon={renewing ? <RingSpinner size={14} className="app-desk-ring-on-primary" /> : <SyncOutlined />}
                disabled={!canRenew}
                onClick={() => void handleRenew()}
              >
                {renewing ? '续约中…' : '续约'}
              </Button>
            </span>
          </Tooltip>

          <Tooltip title={killSelectedDisabledTip || undefined}>
            <span>
              <Button
                danger
                icon={<StopOutlined />}
                loading={killingMode === 'selected'}
                disabled={selectedLiveIds.length === 0 || busyAny}
                onClick={() => void handleKillSelected()}
              >
                {selectedLiveIds.length > 0 ? `结束选中 (${selectedLiveIds.length})` : '结束选中'}
              </Button>
            </span>
          </Tooltip>

          <Button
            danger
            icon={<PoweroffOutlined />}
            loading={killingMode === 'all'}
            disabled={liveInstances.length === 0 || busyAny}
            onClick={() => setConfirmKillAllOpen(true)}
          >
            {liveInstances.length > 0 ? `结束全部 (${liveInstances.length})` : '结束全部'}
          </Button>
        </div>
      </div>

      {feedback ? (
        <div key={feedback.id} className="app-desk-feedback" data-tone={feedback.tone} role="status">
          <span className="app-desk-feedback-icon" aria-hidden="true">
            {feedback.tone === 'success' ? (
              <AnimatedCheck size={14} />
            ) : feedback.tone === 'error' ? (
              <ExclamationCircleOutlined />
            ) : (
              <ThunderboltOutlined />
            )}
          </span>
          <span className="app-desk-feedback-text">
            <strong>{feedback.text}</strong>
            {feedback.detail ? <span className="app-desk-feedback-detail">{feedback.detail}</span> : null}
          </span>
          <button
            type="button"
            className="app-desk-feedback-close"
            aria-label="关闭提示"
            onClick={() => setFeedback(null)}
          >
            <CloseOutlined />
          </button>
        </div>
      ) : null}

      {/* 实例列表 */}
      {loading && !desk ? (
        <div className="app-desk-loading">
          <Spin tip="正在读取应用看台…" />
        </div>
      ) : instances.length === 0 ? (
        <div className="app-desk-empty" role="status">
          <span className="app-desk-empty-icon" aria-hidden="true">
            <DesktopOutlined />
          </span>
          <p className="app-desk-empty-title">还没有通过 aih app 启动的实例</p>
          <p className="app-desk-empty-desc">
            在终端执行下面的命令，或在「网络 → 本机代理」启动带代理应用，实例会自动出现在看台中。
          </p>
          <div className="app-desk-sample-command">
            <code>{SAMPLE_COMMAND}</code>
            <Button
              size="small"
              icon={copiedSample ? <CheckOutlined /> : <CopyOutlined />}
              onClick={() => void handleCopySample()}
            >
              {copiedSample ? '已复制' : '复制'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="app-desk-table" role="region" aria-label="已启动应用实例列表">
          <div className="app-desk-table-head" aria-hidden="true">
            <span className="app-desk-col-check" />
            <span>应用 / Kind</span>
            <span>PID</span>
            <span>代理端口与模式</span>
            <span>状态</span>
            <span className="app-desk-col-uptime">运行时长</span>
          </div>

          <ul className="app-desk-rows">
            {instances.map((instance) => {
              const checked = selectedSet.has(instance.id);
              const state = statusMeta(instance);
              const pids = formatPids(instance.pids);
              const port = extractProxyPort(instance.proxyUrl) || (instance.proxied ? '6152' : '');
              const mode = proxyModeMeta(instance.proxyMode);
              const isRunningOrStarting = instance.live || instance.status === 'running' || instance.status === 'starting';
              const uptimeMs = !isRunningOrStarting && instance.exitedAtMs
                ? instance.exitedAtMs - instance.startedAtMs
                : nowMs - instance.startedAtMs;
              const uptimeText = !isRunningOrStarting && instance.exitedAtMs
                ? `运行 ${formatDuration(uptimeMs)}`
                : formatDuration(uptimeMs);
              const timeTooltip = instance.exitedAtMs
                ? `启动：${formatDateTime(instance.startedAtMs)} · 退出：${formatDateTime(instance.exitedAtMs)}`
                : `启动于 ${formatDateTime(instance.startedAtMs)}`;

              return (
                <li
                  key={instance.id}
                  className="app-desk-row"
                  data-selected={checked ? 'true' : 'false'}
                  data-status={state.tone}
                  data-live={instance.live ? 'true' : 'false'}
                  onClick={(event) => {
                    const target = event.target as HTMLElement | null;
                    if (target?.closest('input, button, a, label, .ant-checkbox-wrapper')) return;
                    toggleSelectOne(instance.id);
                  }}
                >
                  <div className="app-desk-cell app-desk-cell-check">
                    <Checkbox
                      checked={checked}
                      aria-label={`选择 ${instance.name}`}
                      onChange={(event) => toggleSelectOne(instance.id, event.target.checked)}
                    />
                  </div>

                  <div className="app-desk-cell app-desk-cell-app">
                    <div className="app-desk-app-title-row">
                      <span className="app-desk-app-name" title={instance.name}>
                        {instance.name}
                      </span>
                      {instance.kind ? (
                        <span className="app-desk-kind-badge">{instance.kind}</span>
                      ) : null}
                      {instance.adopted ? (
                        <Tooltip title="单实例应用：复用已运行的进程（非本次新拉起）">
                          <span className="app-desk-adopted-badge">adopted</span>
                        </Tooltip>
                      ) : null}
                    </div>
                    {instance.path ? (
                      <span className="app-desk-app-path" title={instance.path}>
                        {instance.path}
                      </span>
                    ) : null}
                  </div>

                  <div className="app-desk-cell app-desk-cell-pid" data-label="PID">
                    {pids.full && pids.full !== pids.display ? (
                      <Tooltip title={`PIDs: ${pids.full}`}>
                        <span className="app-desk-mono">{pids.display}</span>
                      </Tooltip>
                    ) : (
                      <span className="app-desk-mono">{pids.display}</span>
                    )}
                  </div>

                  <div className="app-desk-cell app-desk-cell-proxy" data-label="代理">
                    {instance.proxied ? (
                      <div className="app-desk-proxy-badges">
                        <Tooltip title={sanitizeProxyUrl(instance.proxyUrl) || `127.0.0.1:${port}`}>
                          <span className="app-desk-port-chip">:{port}</span>
                        </Tooltip>
                        <Tooltip title={mode.tip}>
                          <span className="app-desk-mode-chip" data-tone={mode.tone}>
                            {mode.label}
                          </span>
                        </Tooltip>
                      </div>
                    ) : (
                      <span className="app-desk-muted">直连</span>
                    )}
                  </div>

                  <div className="app-desk-cell app-desk-cell-status" data-label="状态">
                    <span className="app-desk-status-chip" data-tone={state.tone}>
                      <span className="app-desk-status-dot" aria-hidden="true" />
                      <span>{state.label}</span>
                    </span>
                  </div>

                  <div className="app-desk-cell app-desk-cell-uptime" data-label="时长">
                    <Tooltip title={timeTooltip}>
                      <span className="app-desk-mono app-desk-uptime-text" data-live={isRunningOrStarting ? 'true' : 'false'}>
                        {uptimeText}
                      </span>
                    </Tooltip>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* 结束全部确认弹窗 */}
      <Modal
        open={confirmKillAllOpen}
        title="确认结束全部运行实例"
        okText="确认结束全部"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: killingMode === 'all' }}
        cancelButtonProps={{ disabled: killingMode === 'all' }}
        onOk={() => void handleKillAllConfirm()}
        onCancel={() => {
          if (killingMode !== 'all') setConfirmKillAllOpen(false);
        }}
      >
        <div className="app-desk-confirm-body">
          <p>
            即将向全部 <strong>{liveInstances.length}</strong> 个正在运行的实例发送终止信号：
          </p>
          <ul className="app-desk-confirm-list">
            {liveInstances.slice(0, 6).map((item) => (
              <li key={item.id}>
                <span>{item.name}</span>
                {item.adopted ? <span className="app-desk-adopted-badge">adopted</span> : null}
                {item.pids && item.pids.length > 0 ? (
                  <span className="app-desk-mono app-desk-confirm-pid">PID {item.pids[0]}</span>
                ) : null}
              </li>
            ))}
            {liveInstances.length > 6 ? (
              <li className="app-desk-confirm-more">以及其余 {liveInstances.length - 6} 个运行实例…</li>
            ) : null}
          </ul>
          {adoptedLiveCount > 0 ? (
            <InlineNote tone="warning">
              其中包含 {adoptedLiveCount} 个接管（adopted）的单实例进程，终止会关闭该应用的现有窗口。
            </InlineNote>
          ) : null}
        </div>
      </Modal>
    </section>
  );
}
