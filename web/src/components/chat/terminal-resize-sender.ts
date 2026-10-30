interface TerminalSize {
  termId: string;
  cols: number;
  rows: number;
}

/** Send at most one resize at a time and retain the latest size during a burst. */
export function createTerminalResizeSender(
  send: (termId: string, cols: number, rows: number) => Promise<unknown>,
  intervalMs = 60,
) {
  let pending: TerminalSize | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let lastSentAt = -Infinity;
  let disposed = false;
  let generation = 0;

  const schedule = () => {
    if (disposed || !pending || inFlight || timer !== null) return;
    const wait = Math.max(0, intervalMs - (Date.now() - lastSentAt));
    if (wait > 0) {
      timer = setTimeout(() => { timer = null; schedule(); }, wait);
      return;
    }
    const size = pending;
    pending = null;
    inFlight = true;
    lastSentAt = Date.now();
    const sendGeneration = generation;
    void Promise.resolve().then(() => {
      if (!disposed && sendGeneration === generation) return send(size.termId, size.cols, size.rows);
      return undefined;
    }).catch(() => {}).finally(() => {
      inFlight = false;
      schedule();
    });
  };
  return {
    enqueue(termId: string, cols: number, rows: number) {
      if (disposed || !termId) return;
      pending = { termId, cols, rows };
      schedule();
    },
    clear() {
      generation += 1;
      pending = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    dispose() {
      disposed = true;
      generation += 1;
      pending = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
