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
  isChatMode: boolean = false,
): void {
  useEffect(() => {
    // 纯聊天模式 (Chat 模式)：完全不持久化任何 projectPath 或 projectDirName，避免本地路径污染 URL
    if (isChatMode || session?.mode === 'chat') {
      writePersistedSelection({
        projectPath: undefined,
        sessionId: session?.draft ? undefined : session?.id,
        provider: session?.draft ? undefined : session?.provider,
        projectDirName: undefined,
      });
      return;
    }

    writePersistedSelection({
      projectPath: project?.path,
      sessionId: session?.draft ? undefined : session?.id,
      provider: session?.draft ? undefined : session?.provider,
      projectDirName: session?.draft ? undefined : session?.projectDirName,
    });
  }, [isChatMode, project?.path, session?.draft, session?.id, session?.mode, session?.projectDirName, session?.provider]);
}

export function triggerHapticFeedback(pattern: number | number[] = 12): void {
  if (typeof window !== 'undefined' && 'navigator' in window && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(pattern);
    } catch (_error) {}
  }
}

export function useMobileChatNavigation(
  setShowChat: Dispatch<SetStateAction<boolean>>,
) {
  const edgeSwipeRef = useRef({ x: 0, y: 0, active: false });
  const back = useCallback((): void => {
    triggerHapticFeedback(15);
    setShowChat(false);
  }, [setShowChat]);

  const touchStart = useCallback((event: TouchEvent<HTMLElement>): void => {
    const touch = event.touches[0];
    if (touch) {
      edgeSwipeRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        active: touch.clientX <= 36, // 鸿蒙 6 标准侧滑返回手势感应边缘
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
    // 鸿蒙 6 跟手判定：横向滑动距离超过 50px 且倾角合理即触发返回
    if (dx > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      back();
    }
  }, [back]);

  return { back, touchStart, touchEnd };
}

export function mergeRunningSessionKeys(...sets: Set<string>[]): Set<string> {
  return new Set(sets.flatMap((set) => [...set]));
}
