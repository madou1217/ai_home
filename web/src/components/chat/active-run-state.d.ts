import type { Provider, Session } from '@/types';

export type ActiveRunLike = {
  runKey: string;
  provider: Provider;
  sessionId?: string;
  draftSessionId?: string;
  projectDirName?: string;
};

export declare function getActualSessionRunKey(provider: Provider | string, sessionId: string, projectDirName?: string): string;

export declare function getSessionRunKey(session: Session | null | undefined): string;

export declare function findActiveRunKeyForSession(
  session: Session | null | undefined,
  activeRuns: Iterable<ActiveRunLike> | ActiveRunLike[]
): string;

export declare function collectRunningSessionKeys(activeRuns: Iterable<ActiveRunLike> | ActiveRunLike[]): Set<string>;

export declare function resolveSelectedSessionQueueKey(
  selectedSession: Session | null | undefined,
  selectedSessionRunKey?: string
): string;
