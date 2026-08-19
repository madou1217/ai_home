import React from 'react';
import { message } from 'antd';
import { accountsAPI } from '@/services/api';
import {
  ACCOUNT_LIST_LOAD_MESSAGE_KEY,
  clearLoadFailureMessage,
  showLoadFailureMessage
} from '@/services/load-failure-message.js';
import type {
  Account,
  AccountAddJob,
  AccountImportJob,
  AccountRefreshJob,
  AccountRemovedEvent,
  AccountsSnapshotRequestResponse
} from '@/types';
import type { TokenConsumedEvent } from '@/services/api';
import { getAccountRef } from '@/features/accounts/account-model-catalog';
import { mergeAccounts, mergeSingleAccount } from '@/features/accounts/account-state';

const ACCOUNT_REMOVE_ANIMATION_MS = 420;
const ACCOUNT_SNAPSHOT_REFRESH_FALLBACK_MS = 70_000;

export interface UseAccountsSnapshotHandlers {
  onImportJob?: (job: AccountImportJob) => void;
  onAuthJob?: (job: AccountAddJob) => void;
  onAccountRefreshJob?: (job: AccountRefreshJob) => void;
  onAccountLive?: (account: Account) => void;
  onAccountRemoved?: (event: AccountRemovedEvent, removedAccount: Account | undefined) => void;
  onRemovalCleanup?: (accountRef: string) => void;
  onTokenConsumed?: (event: TokenConsumedEvent) => void;
}

export interface UseAccountsSnapshotResult {
  accounts: Account[];
  setAccounts: React.Dispatch<React.SetStateAction<Account[]>>;
  hydratingDetails: boolean;
  removingAccountRefs: Record<string, boolean>;
  loading: boolean;
  refreshing: boolean;
  requestAccountsSnapshotUpdate: (options?: {
    announce?: boolean;
    failureMessage?: string;
  }) => Promise<AccountsSnapshotRequestResponse | null>;
  stageAccountRemoval: (target: Pick<Account, 'accountRef'>) => void;
}

export function useAccountsSnapshot(
  handlersRef: React.MutableRefObject<UseAccountsSnapshotHandlers>
): UseAccountsSnapshotResult {
  const [accounts, setAccounts] = React.useState<Account[]>([]);
  const [hydratingDetails, setHydratingDetails] = React.useState(false);
  const [removingAccountRefs, setRemovingAccountRefs] = React.useState<Record<string, boolean>>({});
  const [loading, setLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const removingAccountTimersRef = React.useRef<Record<string, number>>({});
  const accountsSnapshotFallbackTimerRef = React.useRef<number | null>(null);
  const accountsRef = React.useRef<Account[]>([]);
  const hasLoadedAccountsRef = React.useRef(false);
  const accountsSnapshotRevisionRef = React.useRef(0);
  const accountsLoadRequestRef = React.useRef(0);

  const clearAccountsSnapshotRefresh = React.useCallback(() => {
    if (accountsSnapshotFallbackTimerRef.current !== null) {
      window.clearTimeout(accountsSnapshotFallbackTimerRef.current);
      accountsSnapshotFallbackTimerRef.current = null;
    }
    setRefreshing(false);
  }, []);

  const trackAccountsSnapshotRefresh = React.useCallback(() => {
    setRefreshing(true);
    setHydratingDetails(true);
    if (accountsSnapshotFallbackTimerRef.current !== null) {
      window.clearTimeout(accountsSnapshotFallbackTimerRef.current);
    }
    accountsSnapshotFallbackTimerRef.current = window.setTimeout(() => {
      accountsSnapshotFallbackTimerRef.current = null;
      setRefreshing(false);
      setHydratingDetails(false);
    }, ACCOUNT_SNAPSHOT_REFRESH_FALLBACK_MS);
  }, []);

  const cancelAccountRemoval = React.useCallback((accountRef: string) => {
    const key = String(accountRef || '').trim();
    if (!key) return;
    const timer = removingAccountTimersRef.current[key];
    if (timer) {
      window.clearTimeout(timer);
      delete removingAccountTimersRef.current[key];
    }
    setRemovingAccountRefs((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const stageAccountRemoval = React.useCallback((target: Pick<Account, 'accountRef'>) => {
    const accountRef = getAccountRef(target);
    if (!accountRef) return;
    handlersRef.current.onRemovalCleanup?.(accountRef);
    setRemovingAccountRefs((current) => (
      current[accountRef] ? current : { ...current, [accountRef]: true }
    ));
    const currentTimer = removingAccountTimersRef.current[accountRef];
    if (currentTimer) window.clearTimeout(currentTimer);
    removingAccountTimersRef.current[accountRef] = window.setTimeout(() => {
      setAccounts((current) => current.filter((account) => getAccountRef(account) !== accountRef));
      setRemovingAccountRefs((current) => {
        if (!current[accountRef]) return current;
        const next = { ...current };
        delete next[accountRef];
        return next;
      });
      handlersRef.current.onRemovalCleanup?.(accountRef);
      delete removingAccountTimersRef.current[accountRef];
    }, ACCOUNT_REMOVE_ANIMATION_MS);
  }, []);

  const applyAccountsSnapshot = React.useCallback((
    snapshotAccounts: Account[],
    options: { preserveLiveFields?: boolean } = {}
  ) => {
    const incoming = Array.isArray(snapshotAccounts) ? snapshotAccounts : [];
    const incomingRefs = new Set(incoming.map((account) => getAccountRef(account)));
    accountsRef.current
      .filter((account) => !incomingRefs.has(getAccountRef(account)))
      .forEach((account) => stageAccountRemoval(account));

    setAccounts((current) => {
      const next = mergeAccounts(current, incoming, options);
      const nextRefs = new Set(next.map((account) => getAccountRef(account)));
      const exiting = current.filter((account) => {
        const key = getAccountRef(account);
        return Boolean(removingAccountTimersRef.current[key]) && !nextRefs.has(key);
      });
      return [...next, ...exiting];
    });
  }, [stageAccountRemoval]);

  const loadAccounts = React.useCallback(async () => {
    const requestId = ++accountsLoadRequestRef.current;
    const snapshotRevision = accountsSnapshotRevisionRef.current;
    if (hasLoadedAccountsRef.current) setRefreshing(true);
    else setLoading(true);
    try {
      const payload = await accountsAPI.list();
      if (
        requestId !== accountsLoadRequestRef.current
        || snapshotRevision !== accountsSnapshotRevisionRef.current
      ) return;
      clearLoadFailureMessage(message, ACCOUNT_LIST_LOAD_MESSAGE_KEY);
      applyAccountsSnapshot(payload.accounts, {
        preserveLiveFields: Boolean(payload.hydrating)
      });
      setHydratingDetails(Boolean(payload.hydrating));
      hasLoadedAccountsRef.current = true;
    } catch (_error) {
      if (
        requestId === accountsLoadRequestRef.current
        && snapshotRevision === accountsSnapshotRevisionRef.current
      ) {
        showLoadFailureMessage(message, ACCOUNT_LIST_LOAD_MESSAGE_KEY, '加载账号失败');
      }
    } finally {
      if (requestId === accountsLoadRequestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [applyAccountsSnapshot]);

  const requestAccountsSnapshotUpdate = React.useCallback(async (options: {
    announce?: boolean;
    failureMessage?: string;
  } = {}) => {
    trackAccountsSnapshotRefresh();
    try {
      const response = await accountsAPI.requestSnapshot();
      if (options.announce) {
        message.info(response.alreadyRunning ? '账号重新加载已在进行' : '账号重新加载已开始');
      }
      return response;
    } catch (error: any) {
      clearAccountsSnapshotRefresh();
      setHydratingDetails(false);
      message.error(error?.response?.data?.message || error?.message || options.failureMessage || '刷新账号列表失败');
      return null;
    }
  }, [clearAccountsSnapshotRefresh, trackAccountsSnapshotRefresh]);

  React.useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  React.useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  React.useEffect(() => {
    const watcher = accountsAPI.watch({
      onSnapshot: ({ accounts: snapshotAccounts, hydrating }) => {
        accountsSnapshotRevisionRef.current += 1;
        clearLoadFailureMessage(message, ACCOUNT_LIST_LOAD_MESSAGE_KEY);
        applyAccountsSnapshot(snapshotAccounts, {
          preserveLiveFields: Boolean(hydrating)
        });
        setHydratingDetails(Boolean(hydrating));
        hasLoadedAccountsRef.current = true;
        setLoading(false);
      },
      onSnapshotRequested: () => {
        trackAccountsSnapshotRefresh();
      },
      onAccount: (account) => {
        cancelAccountRemoval(getAccountRef(account));
        handlersRef.current.onAccountLive?.(account);
        setAccounts((current) => mergeSingleAccount(current, account));
      },
      onAccountRemoved: (event: AccountRemovedEvent) => {
        const removedAccount = accountsRef.current.find((account) => (
          account.provider === event.provider && account.accountRef === event.accountRef
        ));
        handlersRef.current.onAccountRemoved?.(event, removedAccount);
        stageAccountRemoval(event);
      },
      onHydrated: () => {
        setHydratingDetails(false);
        clearAccountsSnapshotRefresh();
      },
      onImportJob: (job) => handlersRef.current.onImportJob?.(job),
      onAuthJob: (job) => handlersRef.current.onAuthJob?.(job),
      onAccountRefreshJob: (job) => handlersRef.current.onAccountRefreshJob?.(job),
      onTokenConsumed: (event) => handlersRef.current.onTokenConsumed?.(event),
      onError: () => {
        if (accountsSnapshotFallbackTimerRef.current === null) {
          setHydratingDetails(false);
        }
      }
    });
    return () => {
      watcher.close();
    };
  }, [applyAccountsSnapshot, cancelAccountRemoval, clearAccountsSnapshotRefresh, stageAccountRemoval, trackAccountsSnapshotRefresh]);

  React.useEffect(() => {
    return () => {
      accountsLoadRequestRef.current += 1;
      Object.values(removingAccountTimersRef.current).forEach((timer) => {
        window.clearTimeout(timer);
      });
      removingAccountTimersRef.current = {};
      if (accountsSnapshotFallbackTimerRef.current !== null) {
        window.clearTimeout(accountsSnapshotFallbackTimerRef.current);
        accountsSnapshotFallbackTimerRef.current = null;
      }
    };
  }, []);

  return {
    accounts,
    setAccounts,
    hydratingDetails,
    removingAccountRefs,
    loading,
    refreshing,
    requestAccountsSnapshotUpdate,
    stageAccountRemoval
  };
}