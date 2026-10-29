import React from 'react';
import { accountsAPI } from '@/services/api';
import type { AccountAppEntryMap } from '@/features/accounts/account-view-model';

export type AccountAppEntriesResult = Awaited<ReturnType<typeof accountsAPI.listAppEntries>>;

export interface UseAccountAppEntriesResult {
  /** 宿主机实测的 Desktop / CLI 安装情况；null 表示尚未加载（入口图标全部隐藏，避免闪烁）。 */
  appEntries: AccountAppEntryMap | null;
  appCapabilities: AccountAppEntryMap;
  serverRuntime: boolean;
  /** Desktop 运行中的账号（accountRef），用于给入口挂角标。 */
  runningAccounts: string[];
  applyAppEntries: (result: AccountAppEntriesResult) => void;
  markAppEntriesUnavailable: () => void;
  loadAppEntries: (options?: { refresh?: boolean }) => Promise<void>;
}

/**
 * 账号 Desktop / CLI 入口状态（从 Accounts.tsx 抽取）。
 * 轮询由页面通过 startAccountAppEntryPolling 接入（request / onResult / onError），
 * 本 hook 只持有状态与一次性刷新（打开 / 关闭 / 安装后调用 loadAppEntries({ refresh: true })）。
 */
/**
 * 轮询回来的入口状态在绝大多数轮次里和上一轮完全一样，而 React 只按引用比较。
 * 直接 setState 会让整张账号表每 2 秒重渲染一次（实测该页面 20 秒内主线程被占 9.8 秒）。
 * 内容相同就返回上一份引用，React 便跳过这次渲染。
 */
function shallowEqualRecord(left: Record<string, unknown> | null, right: Record<string, unknown> | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => {
    const a = left[key];
    const b = right[key];
    if (a === b) return true;
    // 入口值是 { desktop, cli } 这类小对象，逐字段比一次即可。
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const aKeys = Object.keys(a);
      return aKeys.length === Object.keys(b).length
        && aKeys.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
    }
    return false;
  });
}

function equalStringList(left: string[], right: string[]): boolean {
  if (left === right) return true;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function useAccountAppEntries(): UseAccountAppEntriesResult {
  const [appEntries, setAppEntries] = React.useState<AccountAppEntryMap | null>(null);
  const [appCapabilities, setAppCapabilities] = React.useState<AccountAppEntryMap>({});
  const [runningAccounts, setRunningAccounts] = React.useState<string[]>([]);
  const [serverRuntime, setServerRuntime] = React.useState(false);

  const applyAppEntries = React.useCallback((result: AccountAppEntriesResult) => {
    setAppEntries((current) => (shallowEqualRecord(current, result.entries) ? current : result.entries));
    setAppCapabilities((current) => (shallowEqualRecord(current, result.capabilities) ? current : result.capabilities));
    setRunningAccounts((current) => (equalStringList(current, result.runningAccounts) ? current : result.runningAccounts));
    setServerRuntime(result.serverRuntime === true);
  }, []);

  const markAppEntriesUnavailable = React.useCallback(() => {
    setAppEntries((current) => current || {});
  }, []);

  const loadAppEntries = React.useCallback(async (options: { refresh?: boolean } = {}) => {
    try {
      const result = await accountsAPI.listAppEntries(options);
      applyAppEntries(result);
    } catch (_error) {
      markAppEntriesUnavailable();
    }
  }, [applyAppEntries, markAppEntriesUnavailable]);

  return {
    appEntries,
    appCapabilities,
    runningAccounts,
    serverRuntime,
    applyAppEntries,
    markAppEntriesUnavailable,
    loadAppEntries
  };
}
