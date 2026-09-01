import type { MutableRefObject } from 'react';
import { useEffect } from 'react';
import { getSessionRunKey } from '@/components/chat/active-run-state.js';
import { getThinkingStatusText } from '@/components/chat/provider-pending-policy.js';
import { chatAPI } from '@/services/api';
import type { InteractivePrompt, Session } from '@/types';
import type { DetachedRunBinding } from './runtime-types';
import { legacySessionCacheKey } from './use-legacy-session-history';
import { resolveApiProxyRunSnapshot } from './detached-run-snapshot';

interface DetachedRunRecoveryOptions {
  readonly session: Session;
  readonly sessionRef: MutableRefObject<Session | null>;
  readonly detachedRunRef: MutableRefObject<DetachedRunBinding | null>;
  readonly findRun: (session: Session | null) => string;
  readonly setRunPrompt: (runKey: string, prompt: InteractivePrompt) => void;
  readonly markWatchPending: (session: Session, statusText?: string) => void;
  readonly appendRecoveredContent?: (session: Session, content: string) => void;
}

type ListedActiveRun = Awaited<ReturnType<typeof chatAPI.listActiveRuns>>[number];

export function useDetachedRunRecovery({
  session,
  sessionRef,
  detachedRunRef,
  findRun,
  setRunPrompt,
  markWatchPending,
  appendRecoveredContent,
}: DetachedRunRecoveryOptions): void {
  const effectKey = `${legacySessionCacheKey(session)}:${session.draft ? 'draft' : 'saved'}`;

  useEffect(() => {
    const current = sessionRef.current;
    if (!isCurrentSavedSession(current, effectKey)) return;

    chatAPI.listActiveRuns(current.id, current.provider, current.projectDirName).then((active) => {
      const visible = sessionRef.current;
      if (!visible || legacySessionCacheKey(visible) !== legacySessionCacheKey(current)) return;
      if (findRun(visible)) return;
      const run: ListedActiveRun | undefined = active[0];
      if (!run?.runId) return;
      const stableKey = getSessionRunKey(visible);
      if (!stableKey) return;
      detachedRunRef.current = { sessionKey: stableKey, runId: run.runId };
      markWatchPending(visible, getThinkingStatusText(visible.provider));
      if (run.activePrompt) setRunPrompt(stableKey, run.activePrompt);
      // 刷新后立即渲染已累积的部分内容；后端完成后 watch 收到 turn-completed 重载全量。
      const snapshot = resolveApiProxyRunSnapshot(run);
      if (snapshot) appendRecoveredContent?.(visible, snapshot);
    }).catch(() => {});
  }, [appendRecoveredContent, detachedRunRef, effectKey, findRun, markWatchPending, sessionRef, setRunPrompt]);
}

function isCurrentSavedSession(session: Session | null, effectKey: string): session is Session {
  return Boolean(
    session
    && !session.draft
    && `${legacySessionCacheKey(session)}:saved` === effectKey,
  );
}
