import type {
  AggregatedProject,
  Provider,
  Session,
} from '@/types';
import { isAbsoluteProjectPath } from '@/services/project-path-policy.js';
import type { PersistedChatSelection } from './runtime-types';

function projectLastActivityAt(project: AggregatedProject): number {
  if (!Array.isArray(project.sessions) || project.sessions.length === 0) {
    return Number(project.addedAt) || 0;
  }
  return Math.max(
    ...project.sessions.map((session) => Number(session.updatedAt) || 0),
    Number(project.addedAt) || 0,
  );
}

export function sortSessionsByUpdatedAtDesc(sessions: Session[]): Session[] {
  return [...sessions].sort(
    (left, right) => (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0),
  );
}

export function sortProjectsByLastActivityDesc(
  projects: AggregatedProject[],
): AggregatedProject[] {
  return [...projects].sort(
    (left, right) => projectLastActivityAt(right) - projectLastActivityAt(left),
  );
}

export function normalizeProjectCatalog(projects: AggregatedProject[]): AggregatedProject[] {
  if (!Array.isArray(projects)) return [];
  return sortProjectsByLastActivityDesc(projects.filter((project) => (
    project.name !== '默认项目'
    && project.path !== '默认项目'
    && isAbsoluteProjectPath(project.path)
  )));
}

export function buildDisplayProjects(
  projects: AggregatedProject[],
  selectedProject: AggregatedProject | null,
  selectedSession: Session | null,
): AggregatedProject[] {
  const baseProjects = selectedSession?.draft
    && selectedProject
    && !projects.some((project) => project.path === selectedProject.path)
    ? [{ ...selectedProject, sessions: [] }, ...projects]
    : [...projects];
  const projectsWithDraft = !selectedSession?.draft || !selectedProject
    ? baseProjects
    : baseProjects.map((project) => project.path === selectedProject.path
      ? {
          ...project,
          sessions: sortSessionsByUpdatedAtDesc([
            selectedSession,
            ...project.sessions.filter((session) => session.id !== selectedSession.id),
          ]),
        }
      : project);
  return sortProjectsByLastActivityDesc(projectsWithDraft.map((project) => ({
    ...project,
    sessions: sortSessionsByUpdatedAtDesc(project.sessions),
  })));
}

export function resolveSessionProjectDirName(
  provider: Provider,
  projectPath?: string,
  projectDirName?: string,
): string | undefined {
  const explicitDirName = String(projectDirName || '').trim();
  if (explicitDirName) return explicitDirName;
  if (provider !== 'claude') return undefined;
  const normalizedPath = String(projectPath || '').trim();
  return normalizedPath ? normalizedPath.replace(/[^a-zA-Z0-9]/g, '-') : undefined;
}

export function findProjectBySessionId(
  projects: AggregatedProject[],
  selection: PersistedChatSelection,
): { project: AggregatedProject; session: Session } | null {
  if (!selection.sessionId) return null;
  for (const project of projects) {
    const session = project.sessions.find((candidate) => matchesSelection(candidate, selection));
    if (session) return { project, session };
  }
  return null;
}

function matchesSelection(session: Session, selection: PersistedChatSelection): boolean {
  return session.id === selection.sessionId
    && (!selection.provider || session.provider === selection.provider)
    && (!selection.projectDirName || session.projectDirName === selection.projectDirName);
}
