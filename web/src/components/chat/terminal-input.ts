export interface TerminalInputState {
  termId: string;
  inputBuf: string;
  sending: boolean;
  inputReady: boolean;
}

// Only one write may be in flight per terminal. A definite 404 means the
// server did not write the chunk, so it is safe to retry after reattachment.
// A transport failure is ambiguous: replaying it could execute a command twice.
export async function flushTerminalInput(
  state: TerminalInputState,
  send: (termId: string, data: string) => Promise<{ ok: boolean; error?: string }>,
  onMissing: () => void,
  onUncertain: () => void,
): Promise<void> {
  if (state.sending || !state.termId || !state.inputReady) return;
  state.sending = true;
  try {
    while (state.inputBuf && state.inputReady && state.termId) {
      const chunk = state.inputBuf;
      const target = state.termId;
      state.inputBuf = '';
      let result: { ok: boolean; error?: string };
      try { result = await send(target, chunk); } catch { result = { ok: false }; }
      if (result.ok) continue;
      if (result.error === 'terminal_not_found') {
        state.inputBuf = chunk + state.inputBuf;
        state.inputReady = false;
        onMissing();
      } else {
        onUncertain();
      }
      break;
    }
  } finally {
    state.sending = false;
    if (state.inputBuf && state.inputReady) void flushTerminalInput(state, send, onMissing, onUncertain);
  }
}
