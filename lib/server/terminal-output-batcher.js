'use strict';

// Merge small PTY writes before encoding/SSE dispatch. The byte limit bounds
// memory and latency during sustained output; flush() is an ordering barrier.
function createTerminalOutputBatcher(send, options = {}) {
  const delayMs = options.delayMs || 16;
  const maxBytes = options.maxBytes || 64 * 1024;
  let chunks = [];
  let bytes = 0;
  let timer = null;

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!chunks.length) return;
    const text = chunks.join('');
    chunks = [];
    bytes = 0;
    send(text);
  }

  function push(chunk) {
    if (!chunk) return;
    chunks.push(chunk);
    bytes += Buffer.byteLength(chunk, 'utf8');
    if (bytes >= maxBytes) {
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, delayMs);
      timer.unref?.();
    }
  }

  return { push, flush };
}

module.exports = { createTerminalOutputBatcher };
