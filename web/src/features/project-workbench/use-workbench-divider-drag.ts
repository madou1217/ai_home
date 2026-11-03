import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject, PointerEvent, RefObject } from 'react';
import { suspendBackgroundBlur } from '@/components/chat/terminal-resize-effects';
import { TERMINAL_RESIZE_FINISHED } from '@/components/chat/terminal-refit';
import { applyDividerDrag, clampColumnWidths, columnGridTemplate, DIVIDER_WIDTH } from './workbench-layout';
import type { ColumnCollapsed, ColumnDivider, ColumnVisibility, ColumnWidths } from './workbench-layout';
import { saveColumnLayout } from './workbench-layout-persistence';

interface DividerDragOptions {
  containerRef: RefObject<HTMLDivElement>;
  widthsRef: MutableRefObject<ColumnWidths>;
  desiredRef: MutableRefObject<ColumnWidths>;
  collapsedRef: MutableRefObject<ColumnCollapsed>;
  visibilityRef: MutableRefObject<ColumnVisibility>;
  shownRef: MutableRefObject<ColumnVisibility>;
  templateRef: MutableRefObject<string>;
  setDesired: (widths: ColumnWidths) => void;
}

/** Preview directly on the grid; commit React state and persistence once. */
export function useWorkbenchDividerDrag(options: DividerDragOptions) {
  const cleanupRef = useRef<(() => void) | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => () => cleanupRef.current?.(), []);

  return useCallback((divider: ColumnDivider) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const current = optionsRef.current;
    const node = current.containerRef.current;
    if (!node) return;
    event.preventDefault();
    cleanupRef.current?.();
    const startWidths = current.widthsRef.current;
    const startX = event.clientX;
    const pointerId = event.pointerId;
    const previousSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    const restoreBackgroundBlur = suspendBackgroundBlur();
    let latestX = startX;
    let latestWidths: ColumnWidths | null = null;
    let frame: number | null = null;
    let finishing = false;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const paint = () => {
      frame = null;
      const shown = current.shownRef.current;
      const available = node.clientWidth - DIVIDER_WIDTH * ((shown.left ? 1 : 0) + (shown.right ? 1 : 0));
      if (available <= 0) return;
      latestWidths = applyDividerDrag(startWidths, divider, latestX - startX, available);
      const rendered = clampColumnWidths(latestWidths, available, shown);
      node.style.gridTemplateColumns = columnGridTemplate(rendered, current.visibilityRef.current, current.collapsedRef.current);
    };
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId || next.clientX === latestX) return;
      latestX = next.clientX;
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
      if (!finishing) node.style.gridTemplateColumns = current.templateRef.current;
      cleanupRef.current = null;
    };
    const finish = (next: Event) => {
      if (next instanceof globalThis.PointerEvent && next.pointerId !== pointerId) return;
      if (next.type === 'pointerup') move(next as globalThis.PointerEvent);
      if (frame !== null) { cancelAnimationFrame(frame); paint(); }
      finishing = true;
      cleanup();
      if (latestWidths) {
        current.desiredRef.current = latestWidths;
        current.setDesired(latestWidths);
        saveColumnLayout({ widths: latestWidths, collapsed: current.collapsedRef.current });
        node.querySelectorAll('[data-compact="true"]').forEach((panel) => panel.dispatchEvent(new Event(TERMINAL_RESIZE_FINISHED)));
      }
    };
    cleanupRef.current = cleanup;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
  }, []);
}
