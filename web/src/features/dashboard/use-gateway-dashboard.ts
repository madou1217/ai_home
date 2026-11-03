import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { message } from 'antd';
import { accountsAPI, managementAPI } from '@/services/api';
import type { Account, ManagementAccount, ManagementMetrics, ManagementStatus } from '@/types';
import { countHealthyAccounts } from '@/features/accounts/account-state';
import { buildProviderRows, buildRouteRows } from './dashboard-presentation';

// 账号口径数据（/v0/webui/accounts）的刷新节流：跟随管理快照节奏，但不至于每帧都打一次接口。
const WEBUI_ACCOUNTS_MIN_INTERVAL_MS = 15000;

export type DashboardLiveState = 'connecting' | 'live' | 'degraded';

/**
 * 网关仪表盘数据层（从 pages/Dashboard.tsx 原样抽出，桌面与移动端共用）：
 * - managementAPI.watch 推送快照；2.5s 内无快照或 SSE 出错时回落到 status/metrics/accounts 轮询读取；
 * - 刷新：实时通道可用时 requestSnapshot，2s 未到达再回落；
 * - 清空冷却：managementAPI.clearCooldown，降级模式下主动重载；
 * - 账号健康口径与账号页一致（accountsAPI.list + countHealthyAccounts）。
 */
export function useGatewayDashboard() {
  const [status, setStatus] = useState<ManagementStatus | null>(null);
  const [metrics, setMetrics] = useState<ManagementMetrics | null>(null);
  const [accounts, setAccounts] = useState<ManagementAccount[]>([]);
  // 账号健康口径与账号页一致：全部持久化账号（/v0/webui/accounts）+ getAccountDisplayState。
  const [webuiAccounts, setWebuiAccounts] = useState<Account[]>([]);
  const [webuiAccountsLoaded, setWebuiAccountsLoaded] = useState(false);
  const webuiAccountsFetchedAtRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [cooldownClearing, setCooldownClearing] = useState(false);
  const [liveState, setLiveState] = useState<DashboardLiveState>('connecting');
  const [statusReceivedAt, setStatusReceivedAt] = useState(0);
  const [uptimeTickMs, setUptimeTickMs] = useState(() => Date.now());
  const snapshotReceivedAtRef = useRef(0);
  const refreshFallbackTimerRef = useRef<number | null>(null);

  function clearRefreshFallbackTimer() {
    if (refreshFallbackTimerRef.current === null) return;
    window.clearTimeout(refreshFallbackTimerRef.current);
    refreshFallbackTimerRef.current = null;
  }

  const refreshWebuiAccounts = useCallback(async (options: { force?: boolean } = {}) => {
    const now = Date.now();
    if (!options.force && now - webuiAccountsFetchedAtRef.current < WEBUI_ACCOUNTS_MIN_INTERVAL_MS) return;
    webuiAccountsFetchedAtRef.current = now;
    try {
      const result = await accountsAPI.list();
      setWebuiAccounts(Array.isArray(result.accounts) ? result.accounts : []);
      setWebuiAccountsLoaded(true);
    } catch (_error) {
      // 静默失败：保留上一次账号口径，等待下一轮刷新。
    }
  }, []);

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
    setLoadError('');
    clearRefreshFallbackTimer();
    void refreshWebuiAccounts();
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
      setLoadError('');
      void refreshWebuiAccounts({ force: true });
    } catch (error: any) {
      const errorMessage = error?.response?.data?.message || error?.message || '加载管理面板失败';
      setLoadError(errorMessage);
      if (!quietError) {
        message.error(errorMessage);
      }
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  }, [refreshWebuiAccounts]);

  useEffect(() => {
    setLoading(true);
    void refreshWebuiAccounts({ force: true });
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
    // applyDashboardSnapshot 只读 setter / ref 与稳定的 refreshWebuiAccounts，与原页面一致不列入依赖。
  },[loadDashboard, refreshWebuiAccounts]);

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
    void refreshWebuiAccounts({ force: true });

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

  const providerRows = useMemo(() => buildProviderRows(status, metrics), [metrics, status]);
  const routeRows = useMemo(() => buildRouteRows(metrics), [metrics]);
  const accountHealth = useMemo(() => countHealthyAccounts(webuiAccounts), [webuiAccounts]);
  const accountByRef = useMemo(() => {
    return new Map(
      accounts
        .filter((account) => account.accountRef)
        .map((account) => [String(account.accountRef || ''), account])
    );
  }, [accounts]);

  return {
    status,
    metrics,
    accounts,
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
    recentErrors: metrics?.lastErrors || [],
    handleClearCooldown,
    handleRefreshDashboard
  };
}
