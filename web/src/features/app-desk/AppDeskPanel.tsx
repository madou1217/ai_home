import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Checkbox, Input, Modal, Segmented, Select, Spin, Tooltip, message } from 'antd';
import {
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  DeleteOutlined,
  DesktopOutlined,
  DisconnectOutlined,
  ExclamationCircleOutlined,
  HistoryOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  RocketOutlined,
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
  type AppDeskLaunchProfile,
  type AppDeskProxyStatus,
  type AppDeskView,
  type LocalApp
} from './app-desk-api';
import './AppDeskPanel.css';

const POLL_INTERVAL_MS = 1500;
const CLOCK_TICK_MS = 1000;
const RECONNECT_ANIMATION_MS = 3400;
const FEEDBACK_TTL_MS = 6000;
const SAMPLE_COMMAND = 'aih app "Google Chrome" --proxy';
const SAMPLE_PROXY_URL = 'http://127.0.0.1:6156';

type ProxyVisualState = 'active' | 'reconnecting' | 'stopped';
type LaunchProxyMode = 'direct' | 'default' | 'selector' | 'custom';
type DeskListView = 'active' | 'history';

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

/** 2 字国家码 → 国旗 emoji；未知码返回空串。 */
function countryFlag(code?: string): string {
  const normalized = (code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return '';
  return String.fromCodePoint(...[...normalized].map((char) => 0x1f1e6 + char.charCodeAt(0) - 65));
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
 * 并提供代理续约、恢复方式展示与进程结束控制。
 */
export default function AppDeskPanel() {
  const [desk, setDesk] = useState<AppDeskView | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [renewing, setRenewing] = useState(false);
  const [killingMode, setKillingMode] = useState<'' | 'selected' | 'all'>('');
  const [copiedSample, setCopiedSample] = useState(false);

  // 主列表只放运行中的实例；已结束的行进历史视图，避免列表无限增长。
  const [view, setView] = useState<DeskListView>('active');
  const [history, setHistory] = useState<AppDeskInstance[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);

  // 「启动应用」：把 CLI 的 aih app [--proxy|--proxy-url] 可视化成同一组参数。
  const [launchOpen, setLaunchOpen] = useState(false);
  const [appCatalog, setAppCatalog] = useState<LocalApp[]>([]);
  const [appCatalogLoading, setAppCatalogLoading] = useState(false);
  const [launchAppId, setLaunchAppId] = useState('');
  const [launchProxyMode, setLaunchProxyMode] = useState<LaunchProxyMode>('default');
  const [launchProxyUrl, setLaunchProxyUrl] = useState('');
  const [launchSelector, setLaunchSelector] = useState('');
  const [launching, setLaunching] = useState(false);
  const [rememberedProfile, setRememberedProfile] = useState<AppDeskLaunchProfile | null>(null);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [reconnectBanner, setReconnectBanner] = useState<ReconnectBanner | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);

  const inFlightRef = useRef(false);
  const historyInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const mutationEpochRef = useRef(0);
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
    const epoch = mutationEpochRef.current;
    if (options?.manual) setManualRefreshing(true);
    try {
      const next = await appDeskAPI.getDesk();
      if (!mountedRef.current || epoch !== mutationEpochRef.current) return;
      applyDeskSnapshot(next);
    } catch (error: unknown) {
      if (!mountedRef.current || epoch !== mutationEpochRef.current) return;
      setLoadError(describeAppDeskError(error, '读取应用看台失败'));
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
        if (options?.manual) setManualRefreshing(false);
      }
    }
  }, [applyDeskSnapshot]);

  const fetchHistory = useCallback(async () => {
    if (historyInFlightRef.current) return;
    historyInFlightRef.current = true;
    setHistoryLoading(true);
    try {
      const rows = await appDeskAPI.history();
      if (!mountedRef.current) return;
      setHistory(rows);
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      showFeedback('error', `读取历史失败：${describeAppDeskError(error, '历史读取失败')}`);
    } finally {
      historyInFlightRef.current = false;
      if (mountedRef.current) setHistoryLoading(false);
    }
  }, [showFeedback]);

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

  // 历史视图激活时才拉取已结束记录；不轮询时不会给主看台增加负载。
  useEffect(() => {
    if (view !== 'history') return;
    void fetchHistory();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchHistory();
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [view, fetchHistory]);

  // 本地 1s 时钟：平滑更新运行时长与“最后续约”相对时间。
  useEffect(() => {
    const ticker = window.setInterval(() => {
      setNowMs(Date.now());
    }, CLOCK_TICK_MS);
    return () => window.clearInterval(ticker);
  }, []);

  const instances = desk?.instances ?? [];
  const historyCount = desk?.historyCount ?? 0;
  const historyRows = useMemo(() => history.filter((item) => !item.live), [history]);
  const proxy = desk?.proxy;
  const proxyState = resolveProxyVisualState(proxy, desk?.proxyError);
  const inPlaceRecovery = Boolean(proxy?.inPlace);

  const selectedApp = useMemo(
    () => appCatalog.find((item) => item.id === launchAppId),
    [appCatalog, launchAppId]
  );
  useEffect(() => {
    if (!launchOpen || !launchAppId) {
      setRememberedProfile(null);
      return;
    }
    let cancelled = false;
    void appDeskAPI.getProfile(launchAppId)
      .then((profile) => {
        if (cancelled) return;
        setRememberedProfile(profile);
        const spec = profile?.policy?.proxy;
        if (!spec) return;
        switch (spec.kind) {
          case 'selector':
            if (spec.selector) {
              setLaunchProxyMode('selector');
              setLaunchSelector(spec.selector);
            }
            break;
          case 'url':
            if (spec.url) {
              setLaunchProxyMode('custom');
              setLaunchProxyUrl(spec.url);
            }
            break;
          case 'local':
            setLaunchProxyMode('default');
            break;
          case 'direct':
            setLaunchProxyMode('direct');
            break;
          default:
            break;
        }
      })
      .catch(() => {
        if (!cancelled) setRememberedProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [launchOpen, launchAppId]);

  const launchCustomUrl = launchProxyUrl.trim();
  const launchSelectorValue = launchSelector.trim();
  const launchSelectorValid = launchProxyMode !== 'selector'
    || (launchSelectorValue.length > 0 && !/[\r\n]/.test(launchSelectorValue));
  const launchCustomValid = (() => {
    if (launchProxyMode !== 'custom' || !launchCustomUrl) return false;
    try {
      const parsed = new URL(launchCustomUrl);
      return ['http:', 'https:', 'socks5:', 'socks5h:', 'socks:'].includes(parsed.protocol) && Boolean(parsed.host);
    } catch {
      return false;
    }
  })();
  const launchReady = Boolean(launchAppId)
    && (launchProxyMode !== 'custom' || launchCustomValid)
    && (launchProxyMode !== 'selector' || launchSelectorValid);
  const selectedAppMode = selectedApp?.proxyMode === 'chromium'
    ? '浏览器参数（独立 profile + --proxy-server，可靠生效）'
    : selectedApp
      ? '环境变量（应用若不读取 HTTP(S)_PROXY 则不生效）'
      : '选择应用后显示代理生效方式';

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

  const handleRenew = async (ids?: string[]) => {
    const targets = ids ?? selectedIds;
    if (renewing || targets.length === 0) return;
    if (!ids && !canRenew) return;
    setRenewing(true);
    mutationEpochRef.current += 1;
    const startedAt = Date.now();
    const prevReconnects = proxy?.reconnects ?? 0;
    try {
      const result = await appDeskAPI.renew(targets);
      if (!mountedRef.current) return;
      mutationEpochRef.current += 1;
      const elapsedMs = Math.max(1, Date.now() - startedAt);
      if (result.desk) {
        applyDeskSnapshot(result.desk);
      } else {
        observeProxyTransition(result.proxy);
        setDesk((current) => (current ? { ...current, proxy: result.proxy, proxyError: undefined } : current));
      }
      const leaseTarget = result.proxy.leaseName || '当前出口';
      const reconnected = (result.proxy.reconnects ?? 0) > prevReconnects;
      const summary = result.renewed && result.renewed > 1
        ? `已重连 ${result.renewed} 个代理入口`
        : result.renewed === 1 && !result.proxy.leaseName
          ? '已重连代理入口'
          : reconnected
            ? `已重连上游 · ${leaseTarget}`
            : `已续约代理 · ${leaseTarget}`;
      showFeedback('success', summary, `${elapsedMs}ms`);
      message.success(`${summary}（${elapsedMs}ms）`);
      if (result.errors && result.errors.length > 0) {
        message.warning(result.errors.join('；'));
      }
      void fetchDesk();
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      const info = extractAppDeskError(error, '续约失败');
      if (info.proxy) {
        const nextProxy = info.proxy;
        mutationEpochRef.current += 1;
        observeProxyTransition(nextProxy);
        setDesk((current) => (current ? { ...current, proxy: nextProxy } : current));
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
    mutationEpochRef.current += 1;
    try {
      const result = await appDeskAPI.kill(selectedLiveIds);
      if (!mountedRef.current) return;
      mutationEpochRef.current += 1;
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
    mutationEpochRef.current += 1;
    try {
      const result = await appDeskAPI.kill([]);
      if (!mountedRef.current) return;
      mutationEpochRef.current += 1;
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

  const openKillAllConfirm = () => {
    if (liveInstances.length === 0 || busyAny) return;
    const targets = liveInstances;
    const adoptedCount = targets.filter((item) => item.adopted).length;
    Modal.confirm({
      title: '确认结束全部运行实例',
      okText: '确认结束全部',
      cancelText: '取消',
      okType: 'danger',
      content: (
        <div className="app-desk-confirm-body">
          <p>
            即将向全部 <strong>{targets.length}</strong> 个正在运行的实例发送终止信号：
          </p>
          <ul className="app-desk-confirm-list">
            {targets.slice(0, 6).map((item) => (
              <li key={item.id}>
                <span>{item.name}</span>
                {item.adopted ? <span className="app-desk-adopted-badge">adopted</span> : null}
                {item.pids && item.pids.length > 0 ? (
                  <span className="app-desk-mono app-desk-confirm-pid">PID {item.pids[0]}</span>
                ) : null}
              </li>
            ))}
            {targets.length > 6 ? (
              <li className="app-desk-confirm-more">以及其余 {targets.length - 6} 个运行实例…</li>
            ) : null}
          </ul>
          {adoptedCount > 0 ? (
            <InlineNote tone="warning">
              其中包含 {adoptedCount} 个接管（adopted）的单实例进程，终止会关闭该应用的现有窗口。
            </InlineNote>
          ) : null}
        </div>
      ),
      onOk: () => handleKillAllConfirm()
    });
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

  const loadAppCatalog = useCallback(async () => {
    setAppCatalogLoading(true);
    try {
      const apps = await appDeskAPI.listApps();
      if (mountedRef.current) setAppCatalog(apps);
    } catch (error: unknown) {
      if (mountedRef.current) {
        showFeedback('error', `读取应用列表失败：${describeAppDeskError(error, '应用列表读取失败')}`);
      }
    } finally {
      if (mountedRef.current) setAppCatalogLoading(false);
    }
  }, [showFeedback]);

  const openLaunch = () => {
    setLaunchOpen(true);
    if (appCatalog.length === 0 && !appCatalogLoading) {
      void loadAppCatalog();
    }
  };

  const handleLaunch = async () => {
    if (!launchReady || launching) return;
    setLaunching(true);
    try {
      const result = await appDeskAPI.launchApp({
        id: launchAppId,
        proxy: launchProxyMode !== 'direct',
        proxyUrl: launchProxyMode === 'custom' ? launchCustomUrl : undefined,
        proxySelector: launchProxyMode === 'selector' ? launchSelectorValue : undefined
      });
      if (!mountedRef.current) return;
      const proxyText = result.proxySelector
        ? `节点/地区 ${result.proxySelector}${result.proxyRegion ? ` · ${result.proxyRegion}` : ''}（代理 ${sanitizeProxyUrl(result.proxyUrl)}）`
        : result.proxyUrl
          ? `代理 ${sanitizeProxyUrl(result.proxyUrl)}（${result.proxyLabel || result.app.proxyLabel}）`
          : '直连';
      showFeedback('success', `已启动 ${result.app.name}`, `${proxyText} · 独立实例`);
      message.success(`已启动 ${result.app.name}（${proxyText}）`);
      setLaunchOpen(false);
      setView('active');
      void fetchDesk();
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      const text = describeAppDeskError(error, '启动应用失败');
      showFeedback('error', `启动失败：${text}`);
      message.error(text);
    } finally {
      if (mountedRef.current) setLaunching(false);
    }
  };

  const handleClearHistory = () => {
    if (clearingHistory) return;
    Modal.confirm({
      title: '清空已结束的历史记录',
      content: '只会删除看台历史记录，不会结束任何运行中的实例。',
      okText: '清空历史',
      cancelText: '取消',
      okType: 'danger',
      onOk: async () => {
        setClearingHistory(true);
        try {
          const removed = await appDeskAPI.clearHistory();
          if (!mountedRef.current) return;
          setHistory([]);
          showFeedback('success', `已清理 ${removed} 条历史记录`);
          void fetchDesk();
        } catch (error: unknown) {
          if (!mountedRef.current) return;
          showFeedback('error', `清理历史失败：${describeAppDeskError(error, '清理历史失败')}`);
        } finally {
          if (mountedRef.current) setClearingHistory(false);
        }
      }
    });
  };

  const handleRemoveHistoryRow = async (id: string) => {
    try {
      await appDeskAPI.clearHistory([id]);
      if (!mountedRef.current) return;
      setHistory((current) => current.filter((item) => item.id !== id));
      void fetchDesk();
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      showFeedback('error', `移除历史记录失败：${describeAppDeskError(error, '移除历史记录失败')}`);
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

  const renderInstanceRow = (instance: AppDeskInstance, historyMode: boolean) => {
    const checked = !historyMode && selectedSet.has(instance.id);
    const state = historyMode ? { tone: 'exited' as const, label: '已结束' } : statusMeta(instance);
    const pids = formatPids(instance.pids);
    const port = extractProxyPort(instance.proxyUrl) || (instance.proxied ? '6152' : '');
    const mode = proxyModeMeta(instance.proxyMode);
    const isRunningOrStarting = instance.live || instance.status === 'running' || instance.status === 'starting';
    const uptimeMs = !isRunningOrStarting && instance.exitedAtMs
      ? instance.exitedAtMs - instance.startedAtMs
      : nowMs - instance.startedAtMs;
    const uptimeText = historyMode
      ? instance.exitedAtMs
        ? `结束于 ${formatClock(instance.exitedAtMs)}`
        : '—'
      : !isRunningOrStarting && instance.exitedAtMs
        ? `运行 ${formatDuration(uptimeMs)}`
        : formatDuration(uptimeMs);
    const timeTooltip = instance.exitedAtMs
      ? `启动：${formatDateTime(instance.startedAtMs)} · 退出：${formatDateTime(instance.exitedAtMs)} · 时长 ${formatDuration(uptimeMs)}`
      : `启动于 ${formatDateTime(instance.startedAtMs)}`;

    return (
      <li
        key={instance.id}
        className="app-desk-row"
        data-selected={checked ? 'true' : 'false'}
        data-status={state.tone}
        data-live={instance.live ? 'true' : 'false'}
        data-history={historyMode ? 'true' : 'false'}
        data-proxy-health={instance.proxied && !historyMode ? instance.proxyHealth || 'unknown' : undefined}
        onClick={(event) => {
          if (historyMode) return;
          const target = event.target as HTMLElement | null;
          if (target?.closest('input, button, a, label, .ant-checkbox-wrapper')) return;
          toggleSelectOne(instance.id);
        }}
      >
        <div className="app-desk-cell app-desk-cell-check">
          {historyMode ? (
            <Tooltip title="移除这条历史记录">
              <Button
                size="small"
                type="text"
                icon={<DeleteOutlined />}
                aria-label={`移除 ${instance.name} 的历史记录`}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleRemoveHistoryRow(instance.id);
                }}
              />
            </Tooltip>
          ) : (
            <Checkbox
              checked={checked}
              aria-label={`选择 ${instance.name}`}
              onChange={(event) => toggleSelectOne(instance.id, event.target.checked)}
            />
          )}
        </div>

        <div className="app-desk-cell app-desk-cell-app">
          <div className="app-desk-app-title-row">
            <span className="app-desk-app-name" title={instance.name}>
              {instance.name}
            </span>
            {instance.kind ? <span className="app-desk-kind-badge">{instance.kind}</span> : null}
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
              {instance.proxySelector ? (
                <Tooltip title={`节点/地区选择器：${instance.proxySelector}`}>
                  <span className="app-desk-selector-chip">{instance.proxySelector}</span>
                </Tooltip>
              ) : null}
              {instance.proxyRegion ? (
                <Tooltip title={`出口地区：${countryFlag(instance.proxyCountry)} ${instance.proxyRegion}`}>
                  <span className="app-desk-region-chip">
                    {countryFlag(instance.proxyCountry) ? (
                      <span className="app-desk-region-flag" aria-hidden="true">
                        {countryFlag(instance.proxyCountry)}
                      </span>
                    ) : null}
                    {instance.proxyRegion}
                  </span>
                </Tooltip>
              ) : null}
              {instance.proxyHealth === 'down' ? (
                <>
                  <Tooltip title={instance.proxyHealthDetail || '代理端口不可达'}>
                    <span className="app-desk-proxy-down-chip">
                      <DisconnectOutlined aria-hidden="true" />
                      代理已断开
                    </span>
                  </Tooltip>
                  {!historyMode ? (
                    <Tooltip title="重连代理（在原端口重启临时入口）">
                      <Button
                        size="small"
                        type="text"
                        aria-label={`重连 ${instance.name} 的代理`}
                        loading={renewing}
                        disabled={renewing}
                        icon={<ReloadOutlined />}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleRenew([instance.id]);
                        }}
                      />
                    </Tooltip>
                  ) : null}
                </>
              ) : null}
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
            <span className="app-desk-mono app-desk-uptime-text" data-live={isRunningOrStarting && !historyMode ? 'true' : 'false'}>
              {uptimeText}
            </span>
          </Tooltip>
        </div>
      </li>
    );
  };

  const httpPort = extractProxyPort(proxy?.httpUrl);
  const socksPort = extractProxyPort(proxy?.socks5Url);
  const lastRenewAgo = formatRelativeAgo(proxy?.lastRenewAtMs, nowMs);
  const hasUnexpectedProxyError = Boolean(
    desk?.proxyError && !/控制文件不可用|no such file|cannot find the file/i.test(desk.proxyError)
  );

  return (
    <section className="toolkit-page toolkit-domain-panel app-desk" aria-labelledby="toolkit-app-desk">
      <header className="toolkit-panel-header app-desk-header">
        <div>
          <div className="toolkit-panel-kicker">APP DESK</div>
          <h2 id="toolkit-app-desk">应用看台</h2>
          <p>
            实时跟踪通过 <code>aih app</code> 或 WebUI 启动的本机应用实例，统一管理进程状态、代理续约与上游恢复。
          </p>
        </div>
        <div className="app-desk-header-actions">
          <span className="app-desk-poll-pill" title="页面可见时每 1.5 秒自动轮询看台快照">
            <span className="app-desk-poll-dot" aria-hidden="true" />
            <span>1.5s 轮询</span>
          </span>
          <Button type="primary" icon={<RocketOutlined />} onClick={openLaunch}>
            启动应用
          </Button>
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

      {/* 代理状态卡：完整描边 + 状态点 + 恢复方式，无左侧粗竖条、无大块 Alert */}
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
              {proxy?.region ? <span className="app-desk-metric-sub">{proxy.region}</span> : null}
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
            <dt>恢复方式</dt>
            <dd>
              <strong className="app-desk-metric-value">
                {proxy?.running ? (inPlaceRecovery ? '原地热替换' : '重建入口') : '—'}
              </strong>
              <span className="app-desk-metric-sub">
                {proxy?.running ? (inPlaceRecovery ? '不断线并重试' : '短暂断线') : '入口未运行'}
              </span>
            </dd>
          </div>
        </dl>

        <p className="app-desk-recovery-desc">
          恢复策略：优先原地替换上游并自动重试当前请求；认证入口或 TUN 等无法原地恢复时，才重建入口（短暂断线）。
        </p>

        {proxy?.running && proxy.lastError ? (
          <div className="app-desk-proxy-note">
            <InlineNote tone="warning">代理入口最近报错：{proxy.lastError}</InlineNote>
          </div>
        ) : hasUnexpectedProxyError ? (
          <div className="app-desk-proxy-note">
            <InlineNote tone="warning">代理控制通道异常：{desk?.proxyError}</InlineNote>
          </div>
        ) : null}
      </article>

      {/* 运行中 / 历史 视图切换：已结束实例不再混入主列表 */}
      <div className="app-desk-view-bar">
        <Segmented
          value={view}
          onChange={(value) => setView(value as DeskListView)}
          options={[
            { value: 'active', label: `运行中 ${instances.length}` },
            { value: 'history', label: `历史 ${historyCount}` }
          ]}
        />
        {view === 'history' ? (
          <Button
            danger
            size="small"
            icon={<DeleteOutlined />}
            loading={clearingHistory}
            disabled={historyRows.length === 0 || clearingHistory}
            onClick={handleClearHistory}
          >
            清空历史
          </Button>
        ) : null}
      </div>

      {/* 批量选择与操作工具条 */}
      {view === 'active' ? (
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
                className={renewing ? 'app-desk-renew-btn is-renewing' : 'app-desk-renew-btn'}
                icon={renewing ? <RingSpinner size={14} className="app-desk-ring-on-primary" /> : <SyncOutlined />}
                disabled={!renewing && !canRenew}
                aria-busy={renewing || undefined}
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
            onClick={openKillAllConfirm}
          >
            {liveInstances.length > 0 ? `结束全部 (${liveInstances.length})` : '结束全部'}
          </Button>
        </div>
      </div>
      ) : (
        <div className="app-desk-history-bar">
          <span>
            共 {historyRows.length} 条已结束记录 · 自动保留最近 24 小时
          </span>
          <Button
            size="small"
            icon={<ReloadOutlined spin={historyLoading} />}
            loading={historyLoading}
            onClick={() => void fetchHistory()}
          >
            刷新历史
          </Button>
        </div>
      )}

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

      {/* 实例列表 / 历史列表：已结束的行只在历史视图出现 */}
      {view === 'history' ? (
        historyLoading && historyRows.length === 0 ? (
          <div className="app-desk-loading" role="status">
            <Spin />
            <span className="app-desk-loading-text">正在读取历史…</span>
          </div>
        ) : historyRows.length === 0 ? (
          <div className="app-desk-empty" role="status">
            <span className="app-desk-empty-icon" aria-hidden="true">
              <HistoryOutlined />
            </span>
            <p className="app-desk-empty-title">历史里还没有已结束的实例</p>
            <p className="app-desk-empty-desc">
              实例退出或结束后会在这里保留最近 24 小时；运行中的实例在「运行中」。
            </p>
          </div>
        ) : (
          <div className="app-desk-table" role="region" aria-label="已结束应用实例历史">
            <div className="app-desk-table-head" aria-hidden="true">
              <span className="app-desk-col-check" />
              <span>应用 / Kind</span>
              <span>PID</span>
              <span>代理端口与模式</span>
              <span>状态</span>
              <span className="app-desk-col-uptime">结束时间</span>
            </div>
            <ul className="app-desk-rows">
              {historyRows.map((instance) => renderInstanceRow(instance, true))}
            </ul>
          </div>
        )
      ) : loading && !desk ? (
        <div className="app-desk-loading" role="status">
          <Spin />
          <span className="app-desk-loading-text">正在读取应用看台…</span>
        </div>
      ) : instances.length === 0 ? (
        <div className="app-desk-empty" role="status">
          <span className="app-desk-empty-icon" aria-hidden="true">
            <DesktopOutlined />
          </span>
          <p className="app-desk-empty-title">还没有通过 aih app 启动的实例</p>
          <p className="app-desk-empty-desc">
            点右上角「启动应用」选择应用与代理参数，或在终端执行下面的命令。
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
            {instances.map((instance) => renderInstanceRow(instance, false))}
          </ul>
        </div>
      )}

      {/* 启动应用：把 aih app 的 --proxy / --proxy-url 参数可视化 */}
      <Modal
        title="启动应用"
        open={launchOpen}
        onCancel={() => setLaunchOpen(false)}
        onOk={() => void handleLaunch()}
        okText="启动"
        cancelText="取消"
        confirmLoading={launching}
        okButtonProps={{ disabled: !launchReady }}
        width={560}
      >
        <div className="app-desk-launch-form">
          <label className="app-desk-launch-field">
            <span className="app-desk-launch-label">应用</span>
            <Select
              showSearch
              allowClear
              loading={appCatalogLoading}
              value={launchAppId || undefined}
              placeholder="搜索本机应用（与 alt+space / aih app 同源）"
              optionFilterProp="label"
              onChange={(value) => setLaunchAppId(value || '')}
              options={appCatalog.map((app) => ({
                value: app.id,
                label: `${app.name}${app.kind ? `（${app.kind}）` : ''}`
              }))}
              notFoundContent={appCatalogLoading ? <Spin size="small" /> : '没有匹配的应用'}
            />
          </label>
          {selectedApp ? <p className="app-desk-launch-hint">{selectedApp.path}</p> : null}
          {rememberedProfile?.policy?.proxy ? (
            <p className="app-desk-launch-hint">
              已记住上次：
              {rememberedProfile.policy.proxy.kind === 'selector'
                ? `节点/地区 ${rememberedProfile.policy.proxy.selector || '—'}`
                : rememberedProfile.policy.proxy.kind === 'url'
                  ? `自定义 ${sanitizeProxyUrl(rememberedProfile.policy.proxy.url)}`
                  : rememberedProfile.policy.proxy.kind === 'local'
                    ? '本机代理'
                    : '直连'}
              {rememberedProfile.lastRegion ? ` · ${rememberedProfile.lastRegion}` : ''}
              （启动成功后自动更新）
            </p>
          ) : null}

          <div className="app-desk-launch-field">
            <span className="app-desk-launch-label">代理参数</span>
            <Segmented
              block
              value={launchProxyMode}
              onChange={(value) => setLaunchProxyMode(value as LaunchProxyMode)}
              options={[
                { value: 'direct', label: '直连' },
                { value: 'default', label: '本机' },
                { value: 'selector', label: '节点/地区' },
                { value: 'custom', label: '自定义' }
              ]}
            />
          </div>

          {launchProxyMode === 'default' ? (
            <div className="app-desk-launch-note">
              {proxy?.running && !desk?.proxyError ? (
                <>
                  入口 HTTP :{httpPort || '—'} · 出口 {proxy.leaseName || '—'}
                  {proxy.region ? ` · ${proxy.region}` : ''}（等价 <code>aih app ... --proxy</code>）
                </>
              ) : (
                <InlineNote tone="warning">
                  本机代理入口未运行，启动后应用无法经代理出网；可先在「网络 → 本机代理」启动。
                </InlineNote>
              )}
            </div>
          ) : null}

          {launchProxyMode === 'selector' ? (
            <label className="app-desk-launch-field">
              <span className="app-desk-launch-label">节点 / 地区选择器</span>
              <Input
                value={launchSelector}
                placeholder="us,jp,exclude:cn / node_a40e1afa297a / auto"
                onChange={(event) => setLaunchSelector(event.target.value)}
                status={launchSelector && !launchSelectorValid ? 'error' : undefined}
              />
              <span className="app-desk-launch-hint">
                支持 2 字国家码（us）、3 字城市码（lax）、逗号多选与 exclude: 排除；也可写节点 ID/名称或 auto/pool。
                会为本次应用启动独立临时入口，不影响本机 6152。
              </span>
            </label>
          ) : null}

          {launchProxyMode === 'custom' ? (
            <label className="app-desk-launch-field">
              <span className="app-desk-launch-label">代理 URL</span>
              <Input
                value={launchProxyUrl}
                placeholder={SAMPLE_PROXY_URL}
                onChange={(event) => setLaunchProxyUrl(event.target.value)}
                status={launchCustomUrl && !launchCustomValid ? 'error' : undefined}
              />
              <span className="app-desk-launch-hint">
                支持 http/https/socks5；等价 <code>aih app ... --proxy-url {SAMPLE_PROXY_URL}</code>。
              </span>
            </label>
          ) : null}

          <div className="app-desk-launch-note">
            <span className="app-desk-launch-capability">{selectedAppMode}</span>
            <span className="app-desk-launch-hint">始终启动独立实例，不修改系统代理或全局配置。</span>
          </div>
        </div>
      </Modal>
    </section>
  );
}
