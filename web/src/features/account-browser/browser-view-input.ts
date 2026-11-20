import { useCallback, useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

export type SendBrowserCommand = (command: Record<string, unknown>) => boolean;

type InputOptions = { pointer: boolean; scroll: boolean; text: boolean };
type TouchGesture = { id: number; startX: number; startY: number; lastX: number; lastY: number; scrolling: boolean };
const touchThreshold = 8;
const scrollInterval = 40; // At most 25 commands/sec, including the final queued movement.
const knownKeys = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown']);
const clampDelta = (value: number) => Math.max(-2000, Math.min(2000, value));

function releasePointer(canvas: HTMLCanvasElement, id: number) {
  try {
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  } catch (_) { /* The browser may have already cancelled the pointer. */ }
}

export function useBrowserViewInput(canvasRef: RefObject<HTMLCanvasElement>, send: SendBrowserCommand, options: InputOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const touchesRef = useRef(new Map<number, HTMLCanvasElement>());
  const gestureRef = useRef<TouchGesture | null>(null);
  const rejectedRef = useRef(false);
  const pendingScrollRef = useRef({ x: 0, y: 0 });
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollRef = useRef(0);

  const clearScroll = useCallback(() => {
    if (scrollTimerRef.current !== null) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = null;
    pendingScrollRef.current = { x: 0, y: 0 };
  }, []);

  const reset = useCallback(() => {
    clearScroll();
    gestureRef.current = null;
    rejectedRef.current = false;
    lastScrollRef.current = 0;
    const touches = Array.from(touchesRef.current);
    touchesRef.current.clear();
    for (const [id, canvas] of touches) releasePointer(canvas, id);
  }, [clearScroll]);

  const queueScroll = useCallback((x: number, y: number) => {
    if (!optionsRef.current.scroll || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const pending = pendingScrollRef.current;
    pending.x = clampDelta(pending.x + x);
    pending.y = clampDelta(pending.y + y);
    if (scrollTimerRef.current !== null) return;
    const flush = () => {
      scrollTimerRef.current = null;
      const delta = pendingScrollRef.current;
      pendingScrollRef.current = { x: 0, y: 0 };
      lastScrollRef.current = performance.now();
      if (optionsRef.current.scroll && (delta.x || delta.y)) send({ type: 'scroll', deltaX: delta.x, deltaY: delta.y });
    };
    const wait = Math.max(0, scrollInterval - (performance.now() - lastScrollRef.current));
    scrollTimerRef.current = setTimeout(flush, wait);
  }, [send]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1;
      queueScroll(event.deltaX * unit * canvas.width / box.width, event.deltaY * unit * canvas.height / box.height);
    };
    // React's delegated wheel listener can be passive; keep scrolling on this surface.
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => { canvas.removeEventListener('wheel', wheel); reset(); };
  }, [canvasRef, queueScroll, reset]);

  const tap = (event: ReactPointerEvent<HTMLCanvasElement>, button = 0) => {
    if (!optionsRef.current.pointer) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    send({ type: 'pointer', x, y, button });
  };

  const moveTouch = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId || rejectedRef.current) return;
    if (!gesture.scrolling && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < touchThreshold) return;
    gesture.scrolling = true;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width && box.height) {
      queueScroll((gesture.lastX - event.clientX) * event.currentTarget.width / box.width,
        (gesture.lastY - event.clientY) * event.currentTarget.height / box.height);
    }
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
  };

  const cancelTouch = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!touchesRef.current.has(event.pointerId)) return;
    touchesRef.current.delete(event.pointerId);
    gestureRef.current = null;
    rejectedRef.current = touchesRef.current.size > 0;
    clearScroll();
    releasePointer(event.currentTarget, event.pointerId);
  };

  return {
    reset,
    canvasProps: {
      onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
        event.preventDefault();
        if (event.pointerType !== 'touch') {
          if (!touchesRef.current.size && (event.button === 0 || event.button === 2)) {
            tap(event, event.button);
            event.currentTarget.focus({ preventScroll: true });
          }
          return;
        }
        touchesRef.current.set(event.pointerId, event.currentTarget);
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) { /* Cancellation is handled below. */ }
        if (!event.isPrimary || touchesRef.current.size !== 1 || rejectedRef.current) {
          rejectedRef.current = true;
          gestureRef.current = null;
          clearScroll();
          return;
        }
        // Touch never focuses an input or clicks until it has ended without scrolling.
        gestureRef.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY,
          lastX: event.clientX, lastY: event.clientY, scrolling: false };
      },
      onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
        if (event.pointerType !== 'touch') return;
        event.preventDefault();
        moveTouch(event);
      },
      onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
        if (event.pointerType !== 'touch' || !touchesRef.current.has(event.pointerId)) return;
        event.preventDefault();
        moveTouch(event); // A release beyond the threshold must never become a click.
        const gesture = gestureRef.current;
        if (!rejectedRef.current && gesture?.id === event.pointerId && !gesture.scrolling) tap(event);
        touchesRef.current.delete(event.pointerId);
        if (gesture?.id === event.pointerId) gestureRef.current = null;
        if (!touchesRef.current.size) rejectedRef.current = false;
        releasePointer(event.currentTarget, event.pointerId);
      },
      onPointerCancel: cancelTouch,
      onLostPointerCapture: cancelTouch,
      onContextMenu(event: MouseEvent<HTMLCanvasElement>) { event.preventDefault(); },
      onKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
        if (knownKeys.has(event.key)) {
          if (!optionsRef.current.text) return;
          event.preventDefault();
          send({ type: 'key', key: event.key });
        } else if (optionsRef.current.text && /^[\x20-\x7e]$/.test(event.key)) {
          event.preventDefault();
          send({ type: 'text', text: event.key });
        }
      },
    },
  };
}
