import React from 'react';
import { accountsAPI } from '@/services/api';
import type { AccountAppEntryMap } from '@/features/accounts/account-view-model';

export type AccountAppEntriesResult = Awaited<ReturnType<typeof accountsAPI.listAppEntries>>;

export interface UseAccountAppEntriesResult {
  /** 宿主机实测的 Desktop / CLI 安装情况；null 表示尚未加载（入口图标全部隐藏，避免闪烁）。 */
  appEntries: AccountAppEntryMap | null;
  appCapabilities: AccountAppEntryMap;
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
export function useAccountAppEntries(): UseAccountAppEntriesResult {
  const [appEntries, setAppEntries] = React.useState<AccountAppEntryMap | null>(null);
  const [appCapabilities, setAppCapabilities] = React.useState<AccountAppEntryMap>({});
  const [runningAccounts, setRunningAccounts] = React.useState<string[]>([]);

  const applyAppEntries = React.useCallback((result: AccountAppEntriesResult) => {
    setAppEntries(result.entries);
    setAppCapabilities(result.capabilities);
    setRunningAccounts(result.runningAccounts);
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
    applyAppEntries,
    markAppEntriesUnavailable,
    loadAppEntries
  };
}
