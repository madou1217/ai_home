import type { MutableRefObject } from 'react';
import type { InteractivePrompt, Session } from '@/types';
import type { ActiveSessionRun } from './runtime-types';

interface ActiveRunSnapshot {
  readonly runningSessionKeys: Set<string>;
  readonly statusByKey: Record<string, string>;
  readonly promptsByKey: Record<string, InteractivePrompt>;
}

export const legacyActiveRunStore: {
  readonly activeRunsRef: MutableRefObject<Map<string, ActiveSessionRun>>;
  readonly getSnapshot: () => ActiveRunSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly find: (session: Session | null) => string;
  readonly register: (run: ActiveSessionRun) => void;
  readonly rename: (previousRunKey: string, nextRunKey: string, patch?: Partial<ActiveSessionRun>) => string;
  readonly update: (runKey: string, patch: Partial<ActiveSessionRun>) => void;
  readonly unregister: (runKey: string) => void;
  readonly updateStatus: (runKey: string, statusText: string) => void;
  readonly setPrompt: (runKey: string, prompt: InteractivePrompt) => void;
  readonly restorePrompt: (runKey: string, prompt: InteractivePrompt) => void;
  readonly clearPrompt: (runKey: string, promptId?: string) => void;
  readonly promptForKey: (runKey: string) => InteractivePrompt | null;
};
