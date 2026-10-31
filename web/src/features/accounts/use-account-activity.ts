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
 * 活动快照逐字段比较：服务端每 1s 刷新，但绝大多数轮次里每个账号的
 * inFlight / rate 都没变。原样 setState 会让整张账号表每 2 秒重渲染一次，
 * 实测该页面 20 秒内主线程被占掉数秒（见 Accounts.tsx 的轮询接线）。
 * 内容相同就保留上一份引用，React 会跳过渲染。
 */
function equalActivityMap(
  left: AccountActivityMap | null,
  right: AccountActivityMap | null
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => {
    const a = left[key];
    const b = right[key];
    if (a === b) return true;
    if (!a || !b) return false;
    // 逐字段比：账号数是几十、字段是个位数，比整页重渲染便宜得多。
    const aKeys = Object.keys(a);
    return aKeys.length === Object.keys(b).length
      && aKeys.every((field) => (a as unknown as Record<string, unknown>)[field] === (b as unknown as Record<string, unknown>)[field]);
  });
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
        const next = metrics.accountActivity || null;
        setAccountActivity((current) => (equalActivityMap(current, next) ? current : next));
      } catch (_error) {
        if (!cancelled) setAccountActivity((current) => (current === null ? current : null));
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
