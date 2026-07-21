import { useCallback, useMemo, useState } from 'react';
import { getSessionRunKey } from '@/components/chat/active-run-state.js';
import type { Session } from '@/types';
import type { ApprovalMode } from './session-surface-policy';

export interface SessionApprovalMode {
  readonly mode: ApprovalMode;
  readonly ready: boolean;
  readonly change: (mode: ApprovalMode) => void;
}

export function useSessionApprovalMode(session: Session | null): SessionApprovalMode {
  const key = useMemo(() => storageKey(session), [
    session?.draft, session?.id, session?.projectDirName, session?.provider,
  ]);
  const storedMode = useMemo(() => readMode(key), [key]);
  const [overrides, setOverrides] = useState<Readonly<Record<string, ApprovalMode>>>({});
  const mode = overrides[key] || storedMode;

  const change = useCallback((mode: ApprovalMode): void => {
    setOverrides((current) => ({ ...current, [key]: mode }));
    persistMode(key, mode);
  }, [key]);

  return { mode, ready: true, change };
}

export function persistSessionApprovalMode(session: Session, mode: ApprovalMode): void {
  persistMode(storageKey(session), mode);
}

function storageKey(session: Session | null): string {
  return session && !session.draft
    ? `chat-approval-mode:v1:${getSessionRunKey(session)}`
    : '';
}

function readMode(key: string): ApprovalMode {
  if (!key || typeof window === 'undefined') return 'bypass';
  try {
    const saved = window.localStorage.getItem(key);
    return saved === 'confirm' || saved === 'plan' ? saved : 'bypass';
  } catch (_error) {
    return 'bypass';
  }
}

function persistMode(key: string, mode: ApprovalMode): void {
  if (!key || typeof window === 'undefined') return;
  try { window.localStorage.setItem(key, mode); } catch (_error) {}
}
