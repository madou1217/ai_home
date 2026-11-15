/** Serialize focus updates so rapid switching cannot leave an old size owner. */
export function createTerminalFocusSender(send: (termId: string, active: boolean) => Promise<unknown>) {
  let wanted: { termId: string; active: boolean } | null = null;
  let sent = '';
  let running = false;
  let disposed = false;
  let latest: { termId: string; active: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<unknown> = Promise.resolve();
  let attempts = 0;
  const flush = async () => {
    if (running || disposed) return;
    running = true;
    try {
      while (wanted && !disposed) {
        const next = wanted;
        wanted = null;
        const key = `${next.termId}:${next.active}`;
        if (key === sent) continue;
        try {
          inFlight = send(next.termId, next.active);
          const result = await inFlight as { ok?: boolean };
          if (result?.ok) { sent = key; attempts = 0; }
          else retry(next);
        } catch { retry(next); }
      }
    } finally { running = false; }
  };
  const retry = (failed: { termId: string; active: boolean }) => {
    if (disposed || timer !== null || latest?.termId !== failed.termId || latest.active !== failed.active || ++attempts > 6) return;
    timer = setTimeout(() => { timer = null; if (!disposed && latest) { wanted = latest; void flush(); } }, Math.min(2000, attempts * 250));
  };
  return {
    setActive(termId: string, active: boolean) { if (latest?.termId !== termId || latest.active !== active) attempts = 0; latest = wanted = { termId, active }; void flush(); },
    dispose(termId: string) { disposed = true; wanted = null; if (timer !== null) clearTimeout(timer); if (termId) void inFlight.catch(() => {}).then(() => send(termId, false)).catch(() => {}); },
  };
}
