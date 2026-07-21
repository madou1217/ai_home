import { useCallback, useRef, useState } from 'react';
import { chatAPI } from '@/services/api';
import { getSessionRunKey } from '@/components/chat/active-run-state.js';
import type { TerminalRunState } from '@/components/chat/TerminalDock';
import type { Session } from '@/types';

type TerminalRuns = Record<string, TerminalRunState>;

export interface LegacyTerminalBridge {
  readonly selectedRun: (session: Session) => TerminalRunState | null;
  readonly clearRun: (runKey: string) => void;
  readonly moveRun: (previousRunKey: string, nextRunKey: string) => void;
  readonly startRun: (runKey: string, runId: string, command: string) => void;
  readonly settleRun: (runKey: string) => void;
  readonly writeOutput: (runId: string, data: string) => void;
  readonly registerWriter: (runId: string, writer: ((data: string) => void) | null) => void;
  readonly sendInput: (runId: string, data: string) => void;
  readonly resize: (runId: string, cols: number, rows: number) => void;
  readonly close: (runId: string) => void;
}

export function useLegacyTerminalBridge(): LegacyTerminalBridge {
  const [runs, setRuns] = useState<TerminalRuns>({});
  const writersRef = useRef<Map<string, (data: string) => void>>(new Map());
  const outputBufferRef = useRef<Map<string, string[]>>(new Map());

  const selectedRun = useCallback((session: Session): TerminalRunState | null => (
    runs[getSessionRunKey(session)] || null
  ), [runs]);
  const clearRun = useCallback((runKey: string): void => {
    setRuns((current) => omitRun(current, runKey));
  }, []);
  const moveRun = useCallback((previousRunKey: string, nextRunKey: string): void => {
    setRuns((current) => {
      const run = current[previousRunKey];
      if (!run) return current;
      return { ...omitRun(current, previousRunKey), [nextRunKey]: run };
    });
  }, []);
  const startRun = useCallback((runKey: string, runId: string, command: string): void => {
    setRuns((current) => ({
      ...current,
      [runKey]: { runId, command, active: true },
    }));
  }, []);
  const settleRun = useCallback((runKey: string): void => {
    setRuns((current) => {
      const run = current[runKey];
      if (!run?.active) return current;
      return { ...current, [runKey]: { ...run, active: false } };
    });
  }, []);
  const writeOutput = useCallback((runId: string, data: string): void => {
    if (!runId || !data) return;
    const writer = writersRef.current.get(runId);
    if (writer) {
      writer(data);
      return;
    }
    const buffered = outputBufferRef.current.get(runId) || [];
    buffered.push(data);
    outputBufferRef.current.set(runId, buffered);
  }, []);
  const registerWriter = useCallback((
    runId: string,
    writer: ((data: string) => void) | null,
  ): void => {
    if (!runId) return;
    if (!writer) {
      writersRef.current.delete(runId);
      return;
    }
    writersRef.current.set(runId, writer);
    const buffered = outputBufferRef.current.get(runId);
    buffered?.forEach((chunk) => writer(chunk));
    outputBufferRef.current.delete(runId);
  }, []);
  const sendInput = useCallback((runId: string, data: string): void => {
    if (runId && data) chatAPI.sendRunInput(runId, data, false).catch(() => {});
  }, []);
  const resize = useCallback((runId: string, cols: number, rows: number): void => {
    if (runId) chatAPI.resizeRunTerminal(runId, cols, rows).catch(() => {});
  }, []);
  const close = useCallback((runId: string): void => {
    if (!runId) return;
    chatAPI.abortRun(runId).catch(() => {});
    writersRef.current.delete(runId);
    outputBufferRef.current.delete(runId);
    setRuns((current) => removeRunId(current, runId));
  }, []);

  return {
    selectedRun,
    clearRun,
    moveRun,
    startRun,
    settleRun,
    writeOutput,
    registerWriter,
    sendInput,
    resize,
    close,
  };
}

function omitRun(runs: TerminalRuns, runKey: string): TerminalRuns {
  if (!(runKey in runs)) return runs;
  const next = { ...runs };
  delete next[runKey];
  return next;
}

function removeRunId(runs: TerminalRuns, runId: string): TerminalRuns {
  let changed = false;
  const next = Object.fromEntries(Object.entries(runs).filter(([, run]) => {
    const keep = run.runId !== runId;
    if (!keep) changed = true;
    return keep;
  }));
  return changed ? next : runs;
}
