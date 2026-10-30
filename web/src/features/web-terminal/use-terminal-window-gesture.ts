import { useCallback, useEffect, useRef } from 'react';
import type { CSSProperties, PointerEvent, RefObject } from 'react';
import { TERMINAL_RESIZE_FINISHED } from '@/components/chat/terminal-refit';
import { moveTerminalWindow } from './terminal-window-geometry';
import type { TerminalWindowRect } from './terminal-window-geometry';

/** Keep high-frequency pointer work local to the window; persist once on release. */
export function useTerminalWindowGesture(
  windowRef: RefObject<HTMLDivElement>,
  setPosition: (position: Partial<TerminalWindowRect>) => void,
  scope: string,
  style: CSSProperties | undefined,
) {
  const cleanupRef = useRef<(() => void) | null>(null);
  const styleRef = useRef(style);
  styleRef.current = style;
  useEffect(() => () => cleanupRef.current?.(), [scope]);

  return useCallback((edge: string, event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary || !windowRef.current) return;
    if (edge === 'move' && (event.target as HTMLElement).closest('button, [data-terminal-tab]')) return;
    event.preventDefault();
    event.stopPropagation();
    cleanupRef.current?.();
    const node = windowRef.current;
    const rect = node.getBoundingClientRect();
    const start = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const previousSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    let latest = start;
    let frame: number | null = null;
    let changed = false;
    let finishing = false;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = edge === 'move' ? 'move' : getComputedStyle(event.currentTarget).cursor;
    node.classList.add('is-interacting');

    const paint = () => {
      frame = null;
      node.style.left = `${latest.x}px`;
      node.style.top = `${latest.y}px`;
      if (edge !== 'move') {
        node.style.width = `${latest.width}px`;
        node.style.height = `${latest.height}px`;
      }
    };
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      latest = moveTerminalWindow(start, edge, next.clientX - startX, next.clientY - startY, window.innerWidth, window.innerHeight);
      changed = latest.x !== start.x || latest.y !== start.y || latest.width !== start.width || latest.height !== start.height;
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
      node.classList.remove('is-interacting');
      if (!finishing) {
        const current = styleRef.current;
        node.style.left = String(current?.left ?? '');
        node.style.top = String(current?.top ?? '');
        node.style.width = String(current?.width ?? '');
        node.style.height = String(current?.height ?? '');
      }
      cleanupRef.current = null;
    };
    const finish = (next: Event) => {
      if (next instanceof globalThis.PointerEvent && next.pointerId !== pointerId) return;
      if (next.type === 'pointerup') move(next as globalThis.PointerEvent);
      if (frame !== null) { cancelAnimationFrame(frame); paint(); }
      finishing = true;
      cleanup();
      if (changed) setPosition(edge === 'move' ? { x: latest.x, y: latest.y } : latest);
      if (changed && edge !== 'move') node.dispatchEvent(new Event(TERMINAL_RESIZE_FINISHED));
    };
    cleanupRef.current = cleanup;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
  }, [setPosition, windowRef]);
}
