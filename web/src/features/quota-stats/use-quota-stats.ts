import { useCallback, useEffect, useRef, useState } from 'react';

import { accountsAPI } from '@/services/api';
import type { AccountQuotaStatsResponse } from '@/types';

export interface UseQuotaStatsOptions {
  provider: string;
  accountRef: string;
  windowMinutes: number;
  scopeKey: string;
  rangeDays: number;
}

export interface UseQuotaStatsResult {
  data: AccountQuotaStatsResponse | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

function readErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || '额度统计加载失败');
}

/**
 * 额度统计数据获取。
 *
 * 两个刻意的取舍：
 *   · 换维度/范围时不清空旧数据 —— 先出内容再补，避免整块白屏；
 *   · 用递增序号丢弃过期响应 —— 快速切换维度时，慢请求不能覆盖新结果。
 */
export function useQuotaStats(options: UseQuotaStatsOptions): UseQuotaStatsResult {
  const { provider, accountRef, windowMinutes, scopeKey, rangeDays } = options;
  const [data, setData] = useState<AccountQuotaStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequenceRef = useRef(0);

  const reload = useCallback(async () => {
    if (!provider || !accountRef) return;
    const sequence = sequenceRef.current + 1;
    sequenceRef.current = sequence;
    setLoading(true);
    try {
      const response = await accountsAPI.getQuotaStats(provider, accountRef, {
        window: windowMinutes || undefined,
        scope: scopeKey || undefined,
        rangeDays
      });
      if (sequenceRef.current !== sequence) return;
      setData(response);
      setError(null);
    } catch (loadError) {
      if (sequenceRef.current !== sequence) return;
      setError(readErrorMessage(loadError));
    } finally {
      if (sequenceRef.current === sequence) setLoading(false);
    }
  }, [accountRef, provider, rangeDays, scopeKey, windowMinutes]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload };
}
