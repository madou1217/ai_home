import { message } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { managementAPI } from '@/services/api';
import type { ManagementRestartEvent } from '@/types';
import { describeRestartState } from './settings-config';

/** SSE 丢失终态时的兜底：70s 后解除「重启中」。 */
const RESTART_FALLBACK_MS = 70_000;

/**
 * 「一键重启服务」：managementAPI.restart 发起，managementAPI.watch 推送 restart 事件驱动状态。
 * 桌面 Settings 与移动端 MobileSettings 共用，提示文案一致。
 */
export function useManagementRestart() {
  const [restarting, setRestarting] = useState(false);
  const [restartEvent, setRestartEvent] = useState<ManagementRestartEvent | null>(null);
  const fallbackTimerRef = useRef<number | null>(null);

  const clearFallbackTimer = useCallback(() => {
    if (fallbackTimerRef.current === null) return;
    window.clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = null;
  }, []);

  useEffect(() => {
    const source = managementAPI.watch({
      onRestart: (event) => {
        setRestartEvent(event);
        if (event.status === 'queued' || event.status === 'starting') {
          setRestarting(true);
          return;
        }
        clearFallbackTimer();
        setRestarting(false);
        if (event.status === 'started') {
          message.success('服务重启已启动');
          return;
        }
        if (event.status === 'failed') {
          message.error(event.message || '重启服务失败');
        }
      }
    });
    return () => {
      clearFallbackTimer();
      source.close();
    };
  }, [clearFallbackTimer]);

  const restartServer = useCallback(async () => {
    setRestarting(true);
    try {
      const result = await managementAPI.restart();
      if (result.job) {
        setRestartEvent(result.job);
      }
      clearFallbackTimer();
      fallbackTimerRef.current = window.setTimeout(() => {
        setRestarting(false);
      }, RESTART_FALLBACK_MS);
    } catch (error: unknown) {
      clearFallbackTimer();
      const source = error as { response?: { data?: { message?: string } }; message?: string } | null;
      message.error(source?.response?.data?.message || source?.message || '重启服务失败');
      setRestarting(false);
    }
  }, [clearFallbackTimer]);

  return {
    restarting,
    restartEvent,
    restartNote: describeRestartState(restartEvent, restarting),
    restartServer
  };
}
