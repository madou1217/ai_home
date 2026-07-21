import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction, TouchEvent } from 'react';
import type { AggregatedProject, Session } from '@/types';
import { writePersistedSelection } from './chat-selection-state.js';

export function useMobileImmersiveMode(mobile: boolean, showChat: boolean): void {
  useEffect(() => {
    if (mobile && showChat) document.body.dataset.mobileImmersive = '1';
    else delete document.body.dataset.mobileImmersive;
    return () => { delete document.body.dataset.mobileImmersive; };
  }, [mobile, showChat]);
}

export function usePersistedChatSelection(
  project: AggregatedProject | null,
  session: Session | null,
): void {
  useEffect(() => {
    writePersistedSelection({
      projectPath: project?.path,
      sessionId: session?.draft ? undefined : session?.id,
      provider: session?.draft ? undefined : session?.provider,
      projectDirName: session?.draft ? undefined : session?.projectDirName,
    });
  }, [project?.path, session?.draft, session?.id, session?.projectDirName, session?.provider]);
}

export function useMobileChatNavigation(
  setShowChat: Dispatch<SetStateAction<boolean>>,
) {
  const edgeSwipeRef = useRef({ x: 0, y: 0, active: false });
  const back = useCallback((): void => setShowChat(false), [setShowChat]);
  const touchStart = useCallback((event: TouchEvent<HTMLElement>): void => {
    const touch = event.touches[0];
    if (touch) {
      edgeSwipeRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        active: touch.clientX <= 28,
      };
    }
  }, []);
  const touchEnd = useCallback((event: TouchEvent<HTMLElement>): void => {
    const origin = edgeSwipeRef.current;
    const touch = event.changedTouches[0];
    if (!origin.active || !touch) return;
    edgeSwipeRef.current.active = false;
    const dx = touch.clientX - origin.x;
    const dy = touch.clientY - origin.y;
    if (dx > 64 && Math.abs(dx) > Math.abs(dy) * 1.6) back();
  }, [back]);
  return { back, touchStart, touchEnd };
}

export function mergeRunningSessionKeys(...sets: Set<string>[]): Set<string> {
  return new Set(sets.flatMap((set) => [...set]));
}
