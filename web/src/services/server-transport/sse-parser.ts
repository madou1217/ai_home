import type { ServerSseEvent } from './contract';

export interface ServerSseParser {
  push: (chunk: Uint8Array) => void;
  finish: () => void;
  cancel: () => void;
}

interface PendingEvent {
  type: string;
  data: string[];
  id?: string;
  retry?: number;
  hasData: boolean;
}

function createPendingEvent(): PendingEvent {
  return {
    type: 'message',
    data: [],
    hasData: false
  };
}

function splitField(line: string) {
  const separator = line.indexOf(':');
  if (separator < 0) return { field: line, value: '' };
  const rawValue = line.slice(separator + 1);
  return {
    field: line.slice(0, separator),
    value: rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
  };
}

/**
 * Incremental SSE parser. Raw bytes are decoded with a streaming TextDecoder,
 * so a multi-byte UTF-8 code point may safely span browser or Tauri chunks.
 */
export function createServerSseParser(
  onEvent: (event: ServerSseEvent) => void
): ServerSseParser {
  const decoder = new TextDecoder('utf-8');
  let textBuffer = '';
  let pendingEvent = createPendingEvent();
  let cancelled = false;
  let finished = false;

  const dispatch = () => {
    if (!pendingEvent.hasData || cancelled) {
      pendingEvent = createPendingEvent();
      return;
    }

    onEvent({
      type: pendingEvent.type || 'message',
      data: pendingEvent.data.join('\n'),
      ...(pendingEvent.id !== undefined ? { id: pendingEvent.id } : {}),
      ...(pendingEvent.retry !== undefined ? { retry: pendingEvent.retry } : {})
    });
    pendingEvent = createPendingEvent();
  };

  const processLine = (line: string) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;

    const { field, value } = splitField(line);
    if (field === 'data') {
      pendingEvent.data.push(value);
      pendingEvent.hasData = true;
      return;
    }
    if (field === 'event') {
      pendingEvent.type = value || 'message';
      return;
    }
    if (field === 'id' && !value.includes('\0')) {
      pendingEvent.id = value;
      return;
    }
    if (field === 'retry' && /^\d+$/.test(value)) {
      const retry = Number(value);
      if (Number.isSafeInteger(retry)) pendingEvent.retry = retry;
    }
  };

  const drainLines = (flush: boolean) => {
    while (textBuffer.length > 0) {
      const lineBreakIndex = textBuffer.search(/[\r\n]/);
      if (lineBreakIndex < 0) break;

      const lineBreak = textBuffer[lineBreakIndex];
      if (!flush && lineBreak === '\r' && lineBreakIndex === textBuffer.length - 1) {
        break;
      }

      const line = textBuffer.slice(0, lineBreakIndex);
      const delimiterLength = lineBreak === '\r' && textBuffer[lineBreakIndex + 1] === '\n'
        ? 2
        : 1;
      textBuffer = textBuffer.slice(lineBreakIndex + delimiterLength);
      processLine(line);
    }

    if (flush && textBuffer.length > 0) {
      processLine(textBuffer);
      textBuffer = '';
    }
  };

  return {
    push(chunk) {
      if (cancelled || finished || chunk.byteLength === 0) return;
      textBuffer += decoder.decode(chunk, { stream: true });
      drainLines(false);
    },

    finish() {
      if (cancelled || finished) return;
      finished = true;
      textBuffer += decoder.decode();
      drainLines(true);
      dispatch();
      textBuffer = '';
    },

    cancel() {
      if (cancelled) return;
      cancelled = true;
      textBuffer = '';
      pendingEvent = createPendingEvent();
    }
  };
}
