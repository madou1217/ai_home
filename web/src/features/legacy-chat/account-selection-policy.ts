import type {
  Account,
  ChatAccount,
  Provider,
} from '@/types';
import {
  isAihServerAccount,
  makeAihServerAccount,
} from '@/components/chat/aih-server-account';
import type { QueuedSessionMessage } from './runtime-types';
import { areNativeSessionProvidersCompatible } from '@/components/chat/session-provider-policy.js';

export function resolveQueuedAccount(
  queued: QueuedSessionMessage,
  accounts: Account[],
): ChatAccount | null {
  if (queued.gateway) return makeAihServerAccount(queued.provider);
  return accounts.find((account) => account.accountRef === queued.accountRef) || null;
}

function keepsCurrentAccount(
  current: ChatAccount,
  preferredProvider?: Provider,
  allowSharedNativeSession = false,
): boolean {
  return !preferredProvider || current.provider === preferredProvider
    || (allowSharedNativeSession && !isAihServerAccount(current)
      && areNativeSessionProvidersCompatible(current.provider, preferredProvider));
}

export function pickChatAccount(
  current: ChatAccount | null,
  accounts: Account[],
  preferredProvider?: Provider,
  preferredAccountRef?: string,
  allowSharedNativeSession = false,
): ChatAccount | null {
  if (preferredAccountRef) {
    return accounts.find((account) => account.accountRef === preferredAccountRef
      && (!preferredProvider || account.provider === preferredProvider)) || null;
  }
  if (current && isAihServerAccount(current) && keepsCurrentAccount(current, preferredProvider)) {
    return current;
  }
  if (current && !isAihServerAccount(current)
    && keepsCurrentAccount(current, preferredProvider, allowSharedNativeSession)) {
    const refreshedCurrent = accounts.find((account) => account.accountRef === current.accountRef);
    if (refreshedCurrent) return refreshedCurrent;
  }
  if (preferredProvider) {
    const providerMatch = accounts.find((account) => account.provider === preferredProvider);
    if (providerMatch) return providerMatch;
    return allowSharedNativeSession
      ? accounts.find((account) => areNativeSessionProvidersCompatible(
          account.provider, preferredProvider,
        )) || null
      : null;
  }
  return accounts[0] || null;
}

export function isChatSelectableAccount(account: Account): boolean {
  if (!account.configured || account.status === 'down') return false;
  const schedulableStatus = String(account.schedulableStatus || '').trim();
  if (schedulableStatus && schedulableStatus !== 'schedulable') return false;
  const runtimeStatus = String(account.runtimeStatus || '').trim();
  return !runtimeStatus || runtimeStatus === 'healthy';
}
