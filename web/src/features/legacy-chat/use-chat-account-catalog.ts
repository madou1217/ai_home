import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { message } from 'antd';
import { accountsAPI } from '@/services/api';
import {
  CHAT_ACCOUNT_LIST_LOAD_MESSAGE_KEY,
  clearLoadFailureMessage,
  showLoadFailureMessage,
} from '@/services/load-failure-message.js';
import type { Account, ChatAccount, Provider } from '@/types';
import {
  isChatSelectableAccount,
  pickChatAccount,
} from './account-selection-policy';
import { readCachedChatAccounts, writeCachedChatAccounts } from './chat-cache';

export interface ChatAccountCatalog {
  readonly accounts: Account[];
  readonly accountsRef: MutableRefObject<Account[]>;
  readonly loadFailed: boolean;
  readonly selectedAccount: ChatAccount | null;
  readonly setSelectedAccount: Dispatch<SetStateAction<ChatAccount | null>>;
  readonly selectAccountForProvider: (provider: Provider) => void;
}

export function useChatAccountCatalog(
  preferredProvider?: Provider,
): ChatAccountCatalog {
  const [accounts, setAccounts] = useState<Account[]>(readInitialAccounts);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<ChatAccount | null>(null);
  const accountsRef = useRef<Account[]>(accounts);
  const preferredProviderRef = useRef(preferredProvider);
  const snapshotReceivedAtRef = useRef(0);
  const httpRequestRef = useRef(0);
  preferredProviderRef.current = preferredProvider;

  const applyAccounts = useCallback((incoming: Account[]) => {
    const usable = incoming.filter(isChatSelectableAccount);
    accountsRef.current = usable;
    setAccounts(usable);
    setSelectedAccount((current) => pickChatAccount(
      current,
      usable,
      preferredProviderRef.current,
    ));
  }, []);
  const loadAccounts = useAccountCatalogLoader({
    applyAccounts,
    httpRequestRef,
    setLoadFailed,
    snapshotReceivedAtRef,
  });
  useAccountCatalogWatch({
    accountsRef,
    applyAccounts,
    httpRequestRef,
    loadAccounts,
    snapshotReceivedAtRef,
  });
  const selectAccountForProvider = useCallback((provider: Provider) => {
    setSelectedAccount((current) => {
      if (current?.provider === provider) return current;
      return accountsRef.current.find((account) => account.provider === provider) || current;
    });
  }, []);
  const resolvedSelectedAccount = pickChatAccount(
    selectedAccount,
    accounts,
    preferredProvider,
  );

  return {
    accounts,
    accountsRef,
    loadFailed,
    selectedAccount: resolvedSelectedAccount,
    setSelectedAccount,
    selectAccountForProvider,
  };
}

interface CatalogRequestClock {
  readonly httpRequestRef: MutableRefObject<number>;
  readonly snapshotReceivedAtRef: MutableRefObject<number>;
}

interface CatalogLoaderDependencies extends CatalogRequestClock {
  readonly applyAccounts: (accounts: Account[]) => void;
  readonly setLoadFailed: Dispatch<SetStateAction<boolean>>;
}

interface CatalogWatchDependencies extends CatalogRequestClock {
  readonly accountsRef: MutableRefObject<Account[]>;
  readonly applyAccounts: (accounts: Account[]) => void;
  readonly loadAccounts: () => Promise<void>;
}

function useAccountCatalogLoader(dependencies: CatalogLoaderDependencies): () => Promise<void> {
  const {
    applyAccounts,
    httpRequestRef,
    setLoadFailed,
    snapshotReceivedAtRef,
  } = dependencies;
  return useCallback(async () => {
    const cached = readCachedChatAccounts();
    const requestId = ++httpRequestRef.current;
    const snapshotReceivedAt = snapshotReceivedAtRef.current;
    if (cached.length) applyAccounts(cached);
    try {
      const { accounts } = await accountsAPI.list();
      if (isStaleRequest(dependencies, requestId, snapshotReceivedAt)) return;
      clearAccountLoadFailure();
      applyAccounts(accounts);
      writeCachedChatAccounts(accounts);
      setLoadFailed(false);
    } catch (error) {
      if (isStaleRequest(dependencies, requestId, snapshotReceivedAt)) return;
      setLoadFailed(cached.length === 0);
      if (cached.length === 0) showAccountLoadFailure(error);
    }
  }, [applyAccounts, httpRequestRef, setLoadFailed, snapshotReceivedAtRef]);
}

function useAccountCatalogWatch(dependencies: CatalogWatchDependencies): void {
  const {
    accountsRef,
    applyAccounts,
    httpRequestRef,
    loadAccounts,
    snapshotReceivedAtRef,
  } = dependencies;
  useEffect(() => {
    const fallbackTimer = window.setTimeout(() => {
      if (snapshotReceivedAtRef.current > 0) return;
      void loadAccounts();
    }, 2500);
    const watcher = accountsAPI.watch({
      onSnapshot: ({ accounts }) => {
        snapshotReceivedAtRef.current = Date.now();
        clearAccountLoadFailure();
        applyAccounts(accounts);
      },
      onAccount: (account) => applyAccountUpdate(accountsRef, applyAccounts, account),
      onAccountRemoved: ({ accountRef }) => applyAccounts(
        accountsRef.current.filter((account) => account.accountRef !== accountRef),
      ),
      onError: () => {
        if (snapshotReceivedAtRef.current > 0) return;
        void loadAccounts();
      },
    });
    return () => {
      httpRequestRef.current += 1;
      window.clearTimeout(fallbackTimer);
      watcher.close();
    };
  }, [accountsRef, applyAccounts, httpRequestRef, loadAccounts, snapshotReceivedAtRef]);
}

function applyAccountUpdate(
  accountsRef: MutableRefObject<Account[]>,
  applyAccounts: (accounts: Account[]) => void,
  account: Account,
): void {
  const remaining = accountsRef.current.filter(
    (current) => current.accountRef !== account.accountRef,
  );
  applyAccounts(isChatSelectableAccount(account) ? [...remaining, account] : remaining);
}

function isStaleRequest(
  clock: CatalogRequestClock,
  requestId: number,
  snapshotReceivedAt: number,
): boolean {
  return requestId !== clock.httpRequestRef.current
    || snapshotReceivedAt !== clock.snapshotReceivedAtRef.current;
}

function readInitialAccounts(): Account[] {
  return readCachedChatAccounts().filter(isChatSelectableAccount);
}

function clearAccountLoadFailure(): void {
  clearLoadFailureMessage(message, CHAT_ACCOUNT_LIST_LOAD_MESSAGE_KEY);
}

function showAccountLoadFailure(error: unknown): void {
  const detail = String(error instanceof Error ? error.message : error || '');
  const upstreamFailed = detail.includes('server_proxy_upstream_failed')
    || detail.includes('fetch failed')
    || detail.includes('Network');
  showLoadFailureMessage(
    message,
    CHAT_ACCOUNT_LIST_LOAD_MESSAGE_KEY,
    upstreamFailed ? '远端 server 连接异常，账号未加载，请稍后点刷新重试' : '加载账号失败',
  );
}
