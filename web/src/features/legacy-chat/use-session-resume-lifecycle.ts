import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import type { Session } from '@/types';

type ResumeLifecycleEvent = 'visibility-hidden' | 'visibility-visible' | 'online' | 'pageshow';

export type ResumeLifecycleAction =
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume'; readonly delayMs: number };

interface SessionResumeLifecycleOptions {
  readonly enabled: boolean;
  readonly selectedSessionRef: MutableRefObject<Session | null>;
  readonly connectSessionWatch: (session: Session) => void;
  readonly reloadSessionHistory: (session: Session) => Promise<void>;
  readonly pauseProjectWatch: () => void;
  readonly resumeProjectWatch: () => void;
  readonly refreshProjects: () => Promise<void>;
}

export function resolveResumeLifecycleAction(event: ResumeLifecycleEvent): ResumeLifecycleAction {
  if (event === 'visibility-hidden') return { kind: 'pause' };
  if (event === 'online') return { kind: 'resume', delayMs: 600 };
  return { kind: 'resume', delayMs: 350 };
}

export function useSessionResumeLifecycle({
  enabled,
  selectedSessionRef,
  connectSessionWatch,
  reloadSessionHistory,
  pauseProjectWatch,
  resumeProjectWatch,
  refreshProjects,
}: SessionResumeLifecycleOptions): void {
  const resumeTimerRef = useRef<number | null>(null);

  const resume = useCallback(async (): Promise<void> => {
    resumeProjectWatch();
    const session = selectedSessionRef.current;
    if (!session || session.draft || !enabled) return;
    connectSessionWatch(session);
    try {
      await reloadSessionHistory(session);
      await refreshProjects();
    } catch {}
  }, [
    connectSessionWatch,
    enabled,
    refreshProjects,
    reloadSessionHistory,
    resumeProjectWatch,
    selectedSessionRef,
  ]);

  const scheduleResume = useCallback((delayMs: number): void => {
    if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = window.setTimeout(() => {
      resumeTimerRef.current = null;
      resume().catch(() => {});
    }, delayMs);
  }, [resume]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const handleAction = (action: ResumeLifecycleAction): void => {
      if (action.kind === 'pause') {
        // 当前会话的瞬时事件（例如 CLI retry）无法从 transcript 回放，
        // 页面隐藏时必须保留这条 SSE；这里只暂停可重新拉取的项目目录 watch。
        pauseProjectWatch();
        return;
      }
      scheduleResume(action.delayMs);
    };
    const handleVisibilityChange = (): void => {
      handleAction(resolveResumeLifecycleAction(
        document.visibilityState === 'hidden' ? 'visibility-hidden' : 'visibility-visible',
      ));
    };
    const handleOnline = (): void => handleAction(resolveResumeLifecycleAction('online'));
    const handlePageShow = (): void => handleAction(resolveResumeLifecycleAction('pageshow'));

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, [pauseProjectWatch, scheduleResume]);

  useEffect(() => () => {
    if (resumeTimerRef.current !== null) {
      window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
  }, []);
}
