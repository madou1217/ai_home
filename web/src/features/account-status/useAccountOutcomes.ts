import React from 'react';
import { accountOutcomesAPI } from '@/services/api';
import type { AccountOutcomesData } from './types';

const ACCOUNT_OUTCOMES_POLL_MS = 60_000;

export interface UseAccountOutcomesResult {
  data: AccountOutcomesData | null;
  loading: boolean;
  /** Go 核心未就绪 / 请求失败：状态区应静默隐藏（"状态数据暂不可用"），不打断账号页其他内容 */
  unavailable: boolean;
}

/**
 * 账号健康状态数据源：挂载时拉取一次，此后每 60s 刷新。
 * 失败（网络错误 / 503 account_outcomes_unavailable）不抛出，只置 unavailable。
 */
export function useAccountOutcomes(): UseAccountOutcomesResult {
  const [data, setData] = React.useState<AccountOutcomesData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [unavailable, setUnavailable] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const poll = async () => {
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
        if (!cancelled) setLoading(false);
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, ACCOUNT_OUTCOMES_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return { data, loading, unavailable };
}
