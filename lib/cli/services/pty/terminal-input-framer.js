'use strict';

const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// stdin data events are arbitrary byte chunks, not terminal input events.
// Keep an incomplete CSI together before handing it to a CLI/tmux parser.
// Interpret no keys or mouse actions: each provider owns those semantics.
function createTerminalInputFramer(options = {}) {
  const emit = options.onData;
  const schedule = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  const escapeDelayMs = options.escapeDelayMs ?? 30;
  const sequenceDelayMs = options.sequenceDelayMs ?? 2000;
  const maxSequenceBytes = options.maxSequenceBytes ?? 1024;
  let pending = '';
  let pendingIsBuffer = false;
  let pasting = false;
  let timer = null;

  function stopTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function deliver(value, asBuffer) {
    if (!value) return;
    const bytes = Buffer.from(value, 'latin1');
    emit(asBuffer ? bytes : bytes.toString('utf8'));
  }

  function hold(value, asBuffer) {
    pending = value;
    pendingIsBuffer = asBuffer;
    timer = schedule(() => {
      timer = null;
      const remainder = pending;
      pending = '';
      // A truncated paste terminator must not leave all later input in paste mode.
      pasting = false;
      deliver(remainder, pendingIsBuffer);
    }, value === ESC ? escapeDelayMs : sequenceDelayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function push(data) {
    const asBuffer = Buffer.isBuffer(data);
    // Latin1 is only a byte-preserving working representation, never text decoding.
    const incoming = (asBuffer ? data : Buffer.from(String(data || ''), 'utf8')).toString('latin1');
    if (!incoming) return;
    const outputIsBuffer = pending ? pendingIsBuffer : asBuffer;
    const input = pending + incoming;
    pending = '';
    stopTimer();
    let index = 0;
    while (index < input.length) {
      if (pasting) {
        const end = input.indexOf(PASTE_END, index);
        if (end >= 0) {
          pasting = false;
          index = end + PASTE_END.length;
          continue;
        }
        // Pasted escape sequences are literal data. Only frame the end marker.
        let suffix = Math.min(PASTE_END.length - 1, input.length - index);
        while (suffix > 0 && !input.endsWith(PASTE_END.slice(0, suffix))) suffix -= 1;
        if (suffix > 0) {
          deliver(input.slice(0, -suffix), outputIsBuffer);
          hold(input.slice(-suffix), outputIsBuffer);
          return;
        }
        break;
      }
      const start = input.indexOf(ESC, index);
      if (start < 0) break;
      let end = start + 1;
      if (end < input.length && input[end] !== '[') {
        index = end + 1; // Alt-key and non-CSI protocols stay unchanged.
        continue;
      }
      if (input[end] === '[') {
        end += 1;
        while (end < input.length && input.charCodeAt(end) >= 0x20
          && input.charCodeAt(end) <= 0x3f && end - start < maxSequenceBytes) end += 1;
      }
      if (end === input.length && end - start < maxSequenceBytes) {
        deliver(input.slice(0, start), outputIsBuffer);
        hold(input.slice(start), outputIsBuffer);
        return;
      }
      if (input.slice(start, end + 1) === PASTE_START) pasting = true;
      // Invalid/oversized sequences are preserved too; never erase user input.
      index = end > start + 1 ? end : end + 1;
    }
    deliver(input, outputIsBuffer);
  }

  function reset() {
    stopTimer();
    pending = '';
    pasting = false;
  }

  return { push, reset };
}

module.exports = { createTerminalInputFramer };
