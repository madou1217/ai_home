interface PendingFrame { type: string; data?: string }

/** Preserve early ANSI bytes until an open/attach response identifies the tab. */
export function createTerminalPendingOutput(setBlocked: (blocked: boolean) => void) {
  const frames = new Map<string, PendingFrame[]>();
  const requests = new Map<symbol, string>();
  const retired = new Set<string>();
  let bytes = 0;
  let blocked = false;
  const sizeOf = (frame: PendingFrame) => (frame.data?.length || 0) * 2 + 160;
  const updatePressure = () => {
    const next = bytes >= 1024 * 1024 ? true : bytes <= 256 * 1024 ? false : blocked;
    if (next !== blocked) { blocked = next; setBlocked(next); }
  };
  const clearFrames = () => { frames.clear(); bytes = 0; updatePressure(); };
  const finish = (token: symbol) => {
    if (!requests.delete(token)) return;
    if (!requests.size) clearFrames();
  };
  return {
    begin(owner: string) {
      const token = Symbol(owner);
      requests.set(token, owner);
      return () => finish(token);
    },
    push(termId: string, frame: PendingFrame) {
      if (!requests.size || retired.has(termId)) return;
      const queue = frames.get(termId) || [];
      queue.push(frame);
      frames.set(termId, queue);
      bytes += sizeOf(frame);
      updatePressure();
    },
    drain(termId: string, consume: (frame: PendingFrame) => void) {
      const queue = frames.get(termId);
      if (!queue) return;
      frames.delete(termId);
      // Transfer pressure to xterm's queue before releasing this queue's hold.
      try { for (const frame of queue) consume(frame); }
      finally { bytes -= queue.reduce((total, frame) => total + sizeOf(frame), 0); updatePressure(); }
    },
    retire(termId: string) {
      if (!termId) return;
      retired.add(termId);
      if (retired.size > 1024) retired.delete(retired.values().next().value!);
      const queue = frames.get(termId);
      if (queue) { frames.delete(termId); bytes -= queue.reduce((total, frame) => total + sizeOf(frame), 0); updatePressure(); }
    },
    cancel(owner: string) {
      for (const [token, value] of requests) if (value === owner) finish(token);
    },
    clearFrames,
    clear() { requests.clear(); retired.clear(); clearFrames(); },
  };
}
