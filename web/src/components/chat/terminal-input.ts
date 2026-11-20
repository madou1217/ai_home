interface TerminalInputChunk { data: string; protocol: boolean }

export interface TerminalInputState {
  termId: string;
  inputQueue: TerminalInputChunk[];
  sending: boolean;
  inputReady: boolean;
  attachmentVersion?: number;
}

export function enqueueTerminalInput(state: TerminalInputState, data: string, protocol = false) {
  if (data) state.inputQueue.push({ data, protocol });
}

export function discardTerminalProtocolInput(state: TerminalInputState) {
  state.inputQueue = state.inputQueue.filter((chunk) => !chunk.protocol);
}

// Only one write may be in flight per terminal. A definite 404 means the
// server did not write the chunk, so it is safe to retry after reattachment.
// A transport failure is ambiguous: replaying it could execute a command twice.
export async function flushTerminalInput(
  state: TerminalInputState,
  send: (termId: string, data: string, protocol?: boolean) => Promise<{ ok: boolean; error?: string }>,
  onMissing: () => void,
  onUncertain: () => void,
): Promise<void> {
  if (state.sending || !state.termId || !state.inputReady) return;
  state.sending = true;
  try {
    while (state.inputQueue.length && state.inputReady && state.termId) {
      // Keep source boundaries through HTTP. In particular, never join an
      // automatic reply to a user's keys or paste and lose its classification.
      const protocol = state.inputQueue[0].protocol;
      const boundary = state.inputQueue.findIndex((chunk) => chunk.protocol !== protocol);
      const chunks = state.inputQueue.splice(0, boundary < 0 ? state.inputQueue.length : boundary);
      const target = state.termId;
      const version = state.attachmentVersion;
      let result: { ok: boolean; error?: string };
      try { result = await send(target, chunks.map((chunk) => chunk.data).join(''), protocol); } catch { result = { ok: false }; }
      if (result.ok) continue;
      if (result.error === 'terminal_not_found') {
        // A missing client never received user input. Capability replies belong
        // to that client only and must not be replayed into its replacement.
        state.inputQueue = [...chunks.filter((chunk) => !chunk.protocol), ...state.inputQueue];
        if (state.termId !== target || state.attachmentVersion !== version) continue;
        state.inputReady = false;
        onMissing();
      } else {
        onUncertain();
      }
      break;
    }
  } finally {
    state.sending = false;
    if (state.inputQueue.length && state.inputReady) void flushTerminalInput(state, send, onMissing, onUncertain);
  }
}

/** xterm replies must remain live while a terminal is a read-only preview. */
export function isTerminalProtocolReply(data: string): boolean {
  // Control characters are the xterm protocol payload here, not user text.
  // eslint-disable-next-line no-control-regex
  return /^(?:\x1b\[[0-9;?=>]*[cRnIOt]|\x1b\[[0-9;?]*\$y|\x1b(?:P|\])[^\x1b\x07]*(?:\x07|\x1b\\))+$/.test(data);
}
