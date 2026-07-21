import type { Provider, Session } from '@/types';

export type SessionIdentity = Pick<Session, 'provider' | 'id' | 'projectDirName'>;

export declare function getSessionRunKey(
  session: SessionIdentity
): string;
export declare function isSameSession(
  left: SessionIdentity | null,
  right: SessionIdentity | null
): boolean;

export declare function isSessionRunning(session: Session, runningSessionKeys?: Set<string>): boolean;

export declare function getRunningProviders(projectSessions: Session[], runningSessionKeys?: Set<string>): Set<Provider>;

export declare function getVisibleProjectSessions(
  projectSessions: Session[],
  isExpanded: boolean,
  isSessionsExpanded: boolean,
  collapsedLimit?: number,
  expandedLimit?: number
): Session[];

export declare function getProjectProviderBadges(
  projectProviders: Provider[],
  runningProviders: Set<Provider> | Set<string>,
  isExpanded: boolean
): Array<{
  provider: Provider;
  running: boolean;
}>;
