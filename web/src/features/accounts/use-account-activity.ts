import React from 'react';
import { managementAPI } from '@/services/api';
import type { Account, ManagementAccountActivity } from '@/types';
import { getAccountActivityKey } from '@/features/accounts/account-view-model';
import type { AccountActivityMap } from '@/features/accounts/account-view-model';

const ACCOUNT_ACTIVITY_POLL_MS = 2000;

export interface UseAccountActivityResult {
  accountActivity: AccountActivityMap | null;
  getAccountActivity: (record: Pick<Account, 'provider' | 'accountRef'>) => ManagementAccountActivity | null;
}

/**
 * 网关请求活动轮询（从 Accounts.tsx 抽取）：驱动账号行首图标「运行中」旋转，转速随请求速率变化。
 * 数据来自 /webui/management/metrics 的 accountActivity（服务端每 1s 刷新），本 hook 每 2s 读取。
 */
export function useAccountActivity(): UseAccountActivityResult {
  const [accountActivity, setAccountActivity] = React.useState<AccountActivityMap | null>(null);
  const accountActivityRef = React.useRef<AccountActivityMap | null>(null);
  accountActivityRef.current = accountActivity;

  React.useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const metrics = await managementAPI.metrics();
        if (cancelled) return;
        setAccountActivity(metrics.accountActivity || null);
      } catch (_error) {
        if (!cancelled) setAccountActivity(null);
      }
    };
    poll();
    const timer = setInterval(poll, ACCOUNT_ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const getAccountActivity = React.useCallback((record: Pick<Account, 'provider' | 'accountRef'>) => {
    const activities = accountActivityRef.current;
    if (!activities) return null;
    return activities[getAccountActivityKey(record)] || null;
  }, []);

  return { accountActivity, getAccountActivity };
}
