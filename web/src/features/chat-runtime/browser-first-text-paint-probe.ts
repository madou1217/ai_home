import type { TimelineItem } from '@/chat-runtime';
import type {
  RuntimeCommandNotice,
  RuntimeCommandObserver,
} from './runtime-command-observer';

export const FIRST_TEXT_PAINT_MEASURE =
  'aih.chat-runtime.first-assistant-text-paint';

export interface PerformanceTimelinePort {
  mark(name: string): void;
  measure(
    name: string,
    startMark: string,
    endMark: string,
    detail: Readonly<Record<string, string>>,
  ): void;
  clearMark(name: string): void;
}

export interface PaintScheduler {
  afterNextPaint(callback: () => void): () => void;
}

export interface CommittedTimelineObserver {
  observeCommittedTimeline(items: readonly TimelineItem[]): void;
}

interface PendingPaintSample {
  readonly commandId: string;
  readonly startMark: string;
  readonly endMark: string;
  readonly anchorItemId?: string;
  paintScheduled: boolean;
  cancelPaint?: () => void;
}

interface ProbeOptions {
  readonly performance?: PerformanceTimelinePort;
  readonly scheduler?: PaintScheduler;
}

export class BrowserFirstTextPaintProbe
implements RuntimeCommandObserver, CommittedTimelineObserver {
  private readonly performance: PerformanceTimelinePort;
  private readonly scheduler: PaintScheduler;
  private timelineTailId?: string;
  private pending?: PendingPaintSample;
  private disposed = false;

  constructor(
    private readonly sessionId: string,
    options: ProbeOptions = {},
  ) {
    this.performance = options.performance ?? createBrowserPerformanceTimeline();
    this.scheduler = options.scheduler ?? createBrowserPaintScheduler();
  }

  onCommandDispatch(notice: RuntimeCommandNotice): void {
    if (this.disposed || notice.type !== 'turn.submit') return;
    this.cancelPending();
    const identity = markIdentity(this.sessionId, notice.commandId);
    const pending: PendingPaintSample = {
      commandId: notice.commandId,
      startMark: `${FIRST_TEXT_PAINT_MEASURE}.start:${identity}`,
      endMark: `${FIRST_TEXT_PAINT_MEASURE}.end:${identity}`,
      anchorItemId: this.timelineTailId,
      paintScheduled: false,
    };
    this.pending = pending;
    safeCall(() => this.performance.mark(pending.startMark));
  }

  onCommandDispatchFailed(notice: RuntimeCommandNotice): void {
    if (this.pending?.commandId === notice.commandId) this.cancelPending();
  }

  observeCommittedTimeline(items: readonly TimelineItem[]): void {
    this.timelineTailId = items.length > 0 ? items[items.length - 1].id : undefined;
    const pending = this.pending;
    if (!pending || pending.paintScheduled || this.disposed) return;
    const item = firstNewAssistantText(items, pending.anchorItemId);
    if (!item) return;
    pending.paintScheduled = true;
    pending.cancelPaint = this.scheduler.afterNextPaint(() => {
      if (this.pending !== pending || this.disposed) return;
      safeCall(() => {
        this.performance.mark(pending.endMark);
        this.performance.measure(
          FIRST_TEXT_PAINT_MEASURE,
          pending.startMark,
          pending.endMark,
          {
            sessionId: this.sessionId,
            commandId: pending.commandId,
            itemId: item.id,
          },
        );
      });
      this.clearPendingMarks(pending);
      this.pending = undefined;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPending();
  }

  private cancelPending(): void {
    const pending = this.pending;
    if (!pending) return;
    pending.cancelPaint?.();
    this.clearPendingMarks(pending);
    this.pending = undefined;
  }

  private clearPendingMarks(pending: PendingPaintSample): void {
    safeCall(() => this.performance.clearMark(pending.startMark));
    safeCall(() => this.performance.clearMark(pending.endMark));
  }
}

function firstNewAssistantText(
  items: readonly TimelineItem[],
  anchorItemId: string | undefined,
): TimelineItem | undefined {
  const anchorIndex = anchorItemId
    ? items.findIndex((item) => item.id === anchorItemId)
    : -1;
  if (anchorItemId && anchorIndex < 0) return undefined;
  return items.slice(anchorIndex + 1).find((item) => (
    item.kind === 'message'
    && item.detail.role === 'assistant'
    && Boolean(item.content?.trim())
  ));
}

function markIdentity(sessionId: string, commandId: string): string {
  return `${encodeURIComponent(sessionId)}:${encodeURIComponent(commandId)}`;
}

function createBrowserPerformanceTimeline(): PerformanceTimelinePort {
  return {
    mark(name) {
      globalThis.performance?.mark?.(name);
    },
    measure(name, startMark, endMark, detail) {
      const performance = globalThis.performance;
      if (!performance?.measure) return;
      try {
        performance.measure(name, { start: startMark, end: endMark, detail });
      } catch (_error) {
        performance.measure(name, startMark, endMark);
      }
    },
    clearMark(name) {
      globalThis.performance?.clearMarks?.(name);
    },
  };
}

function createBrowserPaintScheduler(): PaintScheduler {
  return {
    afterNextPaint(callback) {
      const requestFrame = globalThis.requestAnimationFrame?.bind(globalThis);
      const cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis);
      if (!requestFrame || !cancelFrame) {
        const timeout = globalThis.setTimeout(callback, 0);
        return () => globalThis.clearTimeout(timeout);
      }
      let innerFrame: number | undefined;
      const outerFrame = requestFrame(() => {
        innerFrame = requestFrame(callback);
      });
      return () => {
        cancelFrame(outerFrame);
        if (innerFrame !== undefined) cancelFrame(innerFrame);
      };
    },
  };
}

function safeCall(operation: () => void): void {
  try { operation(); } catch (_error) {}
}
