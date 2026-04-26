import type { Provider, Session } from '@/types';

export declare function getSessionRunKey(session: Session): string;

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
  spinning: boolean;
}>;
