import React from 'react';
import { accountOutcomesAPI, accountsAPI } from '@/services/api';
import type { AccountOutcomesData } from './types';


export interface UseAccountOutcomesResult {
  data: AccountOutcomesData | null;
  loading: boolean;
  /** Go 核心未就绪 / 请求失败：状态区应静默隐藏（"状态数据暂不可用"），不打断账号页其他内容 */
  unavailable: boolean;
}

/**
 * 账号健康状态数据源：挂载时拉一次；之后由 accounts/watch 的 snapshot/account
 * 事件触发刷新（500ms 合并），不再周期轮询。失败只置 unavailable。
 */
export function useAccountOutcomes(): UseAccountOutcomesResult {
  const [data, setData] = React.useState<AccountOutcomesData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [unavailable, setUnavailable] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (cancelled) return;
      if (inFlight) {
        dirty = true;
        return;
      }
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void poll();
      }, 500);
    };

    const poll = async () => {
      if (cancelled) return;
      if (inFlight) {
        dirty = true;
        return;
      }
      inFlight = true;
      dirty = false;
      try {
        const response = await accountOutcomesAPI.get();
        if (cancelled) return;
        if (response.ok && response.data) {
          setData(response.data);
          setUnavailable(false);
        } else {
          setUnavailable(true);
        }
      } catch (_error) {
        if (!cancelled) setUnavailable(true);
      } finally {
        inFlight = false;
        if (!cancelled) {
          setLoading(false);
          if (dirty) {
            dirty = false;
            schedule();
          }
        }
      }
    };

    void poll();
    const watcher = accountsAPI.watch({
      onSnapshot: schedule,
      onAccount: schedule
    });
    return () => {
      cancelled = true;
      dirty = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      watcher.close();
    };
  }, []);

  return { data, loading, unavailable };
}
