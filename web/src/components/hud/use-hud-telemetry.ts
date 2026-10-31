import { useEffect, useRef, useState } from 'react';
import { managementAPI } from '@/services/api';
import type { ManagementStatus } from '@/types';
import {
  INITIAL_FAILURE_STATE,
  nextPollDelay,
  recordGatewayFailure,
  recordGatewaySuccess,
  type GatewayFailureState,
} from './gateway-failure-policy';

export type HudGatewayState = 'connecting' | 'online' | 'degraded' | 'empty' | 'offline';

export interface HudTelemetry {
  state: HudGatewayState;
  status: ManagementStatus | null;
  /** 收到快照时的本地时间，用于在两次轮询之间推算运行时长 */
  receivedAt: number;
  /** 最近有失败但还没到离线阈值：正在快速重试。 */
  reconnecting: boolean;
}

const POLL_INTERVAL_MS = 15000;

/** 由真实 ManagementStatus 推导网关状态，不引入任何额外口径。 */
export function deriveGatewayState(status: ManagementStatus | null, failed: boolean): HudGatewayState {
  if (failed) return 'offline';
  if (!status) return 'connecting';
  // 只有显式 ok:false 才判离线；请求本身成功但缺字段时不误报离线。
  if (status.ok === false) return 'offline';
  if (!status.totalAccounts) return 'empty';
  if (status.activeAccounts > 0) return 'online';
  return 'degraded';
}

/**
 * HUD 顶栏遥测：轮询 /webui/management/status（与仪表盘同一接口）。
 * enabled=false（未完成 Server 配置）时不发请求；页面不可见时暂停轮询。
 * 单次失败不判离线（见 gateway-failure-policy）：先快速重试，连续失败才显示 OFFLINE。
 */
export function useHudTelemetry(enabled: boolean): HudTelemetry {
  const [status, setStatus] = useState<ManagementStatus | null>(null);
  const [failure, setFailure] = useState<GatewayFailureState>(INITIAL_FAILURE_STATE);
  const [receivedAt, setReceivedAt] = useState(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let timer: number | undefined;
    let failureState = INITIAL_FAILURE_STATE;

    const schedule = () => {
      if (disposed) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(load, nextPollDelay(failureState, POLL_INTERVAL_MS));
    };

    const load = async () => {
      if (inFlightRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        schedule();
        return;
      }
      inFlightRef.current = true;
      try {
        const next = await managementAPI.status();
        if (disposed) return;
        failureState = recordGatewaySuccess();
        setStatus(next);
        setFailure(failureState);
        setReceivedAt(Date.now());
      } catch (error) {
        if (disposed) return;
        failureState = recordGatewayFailure(failureState, error);
        setFailure(failureState);
      } finally {
        inFlightRef.current = false;
        schedule();
      }
    };

    void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);

  return {
    state: deriveGatewayState(status, failure.offline),
    status,
    receivedAt,
    reconnecting: failure.consecutiveFailures > 0 && !failure.offline,
  };
}
