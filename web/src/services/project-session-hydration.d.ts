import type { AggregatedProject } from '@/types';

interface SessionSelection {
  sessionId?: string;
  provider?: string;
  projectDirName?: string;
}

interface HydrationGuard {
  requestId: number;
  latestRequestId?: number;
  serverKey: string;
  currentServerKey: string;
  projectPath: string;
  responseProjectPath?: string;
  currentProjectPaths: Set<string>;
}

export function isProjectSessionSnapshotComplete(project: AggregatedProject): boolean;
export function shouldHydrateProjectSessions(
  project: AggregatedProject,
  selection?: SessionSelection,
): boolean;
export function isHydratedProjectSessionsStale(
  compactProject: AggregatedProject,
  hydratedProject: AggregatedProject,
): boolean;
export function mergeHydratedProjectSessions(
  snapshotProject: AggregatedProject,
  hydratedProject?: AggregatedProject,
): AggregatedProject;
export function applyProjectSessionHydrationResponse(
  latestProject: AggregatedProject,
  hydratedProject: AggregatedProject,
): AggregatedProject;
export function preserveHydratedProjectSessions(
  projects: AggregatedProject[],
  hydratedProjectsByPath: Map<string, AggregatedProject>,
): AggregatedProject[];
export function canApplyProjectSessionHydration(input: HydrationGuard): boolean;
