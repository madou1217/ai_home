import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent, RefObject } from 'react';
import { TERMINAL_RESIZE_FINISHED } from './terminal-refit';
import { suspendBackgroundBlur } from './terminal-resize-effects';

export function useTerminalDockResize(
  panelRef: RefObject<HTMLDivElement>,
  height: number,
  styleHeight: string,
  enabled: boolean,
  minHeight: number,
  maxHeight: () => number,
  commit: (height: number) => void,
) {
  const cleanupRef = useRef<(() => void) | null>(null);
  const currentStyle = useRef(styleHeight);
  currentStyle.current = styleHeight;
  useEffect(() => () => cleanupRef.current?.(), [enabled]);

  const clamp = useCallback((value: number) => Math.max(minHeight, Math.min(maxHeight(), value)), [maxHeight, minHeight]);
  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || event.button !== 0 || !event.isPrimary || !panelRef.current) return;
    event.preventDefault();
    cleanupRef.current?.();
    const node = panelRef.current;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const previousSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    let latest = height;
    let frame: number | null = null;
    let finishing = false;
    const restoreBackgroundBlur = suspendBackgroundBlur();
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';

    const paint = () => { frame = null; node.style.height = `${latest}px`; };
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      latest = clamp(height + startY - next.clientY);
      if (frame === null) frame = requestAnimationFrame(paint);
    };
    const cleanup = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      document.body.style.userSelect = previousSelect;
      document.body.style.cursor = previousCursor;
      restoreBackgroundBlur();
      if (!finishing) node.style.height = currentStyle.current;
      cleanupRef.current = null;
    };
    const finish = (next: Event) => {
      if (next instanceof globalThis.PointerEvent && next.pointerId !== pointerId) return;
      if (next.type === 'pointerup') move(next as globalThis.PointerEvent);
      if (frame !== null) { cancelAnimationFrame(frame); paint(); }
      finishing = true;
      cleanup();
      if (latest !== height) {
        commit(latest);
        node.dispatchEvent(new Event(TERMINAL_RESIZE_FINISHED));
      }
    };
    cleanupRef.current = cleanup;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
  }, [clamp, commit, enabled, height, panelRef]);

  const resizeWithKeyboard = useCallback((delta: number) => {
    const next = clamp(height + delta);
    if (next !== height) commit(next);
  }, [clamp, commit, height]);

  return { onPointerDown, resizeWithKeyboard };
}
