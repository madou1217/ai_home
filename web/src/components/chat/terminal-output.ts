import type { Terminal } from '@xterm/xterm';

/** Keep a single xterm parse in flight. Bursts are joined outside React. */
export function createTerminalOutput(term: Terminal, isForeground: () => boolean, setBlocked: (blocked: boolean) => void = () => {}) {
  let chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing = false;
  let disposed = false;
  let generation = 0;
  let inFlightBytes = 0;
  let blocked = false;
  const updatePressure = () => {
    const bytes = length + inFlightBytes;
    const next = bytes >= 256 * 1024 ? true : bytes <= 64 * 1024 ? false : blocked;
    if (next !== blocked) { blocked = next; setBlocked(next); }
  };
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (disposed || writing || !length) return;
    // Bound each parse/copy. The shared fetch reader pauses at the high-water
    // mark, so ANSI bytes remain ordered without dropping terminal output.
    const batch = new Uint8Array(Math.min(length, 64 * 1024));
    let offset = 0;
    while (offset < batch.length) {
      const chunk = chunks[0];
      const take = Math.min(chunk.length, batch.length - offset);
      batch.set(chunk.subarray(0, take), offset);
      offset += take;
      if (take === chunk.length) chunks.shift();
      else chunks[0] = chunk.subarray(take);
    }
    length -= batch.length;
    inFlightBytes = batch.length;
    writing = true;
    const current = generation;
    term.write(batch, () => {
      if (disposed || current !== generation) return;
      writing = false;
      inFlightBytes = 0;
      updatePressure();
      schedule();
    });
  };
  const schedule = () => {
    if (disposed || writing || timer !== null || !length) return;
    timer = setTimeout(flush, isForeground() ? 16 : 80);
  };
  return {
    write(chunk: Uint8Array) { if (disposed) return; chunks.push(chunk); length += chunk.length; updatePressure(); schedule(); },
    flush,
    dispose() { disposed = true; generation += 1; if (timer !== null) clearTimeout(timer); chunks = []; length = 0; if (blocked) setBlocked(false); },
  };
}
