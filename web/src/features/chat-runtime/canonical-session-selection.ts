import type { AggregatedProject, Session } from '@/types';

interface PersistedSessionIdentity {
  readonly projectPath?: string;
  readonly sessionId?: string;
  readonly provider?: string;
}

interface CanonicalSelectionInput {
  readonly ready: boolean;
  readonly projects: readonly AggregatedProject[];
  readonly selectedSession: Session | null;
  readonly persistedSelection: PersistedSessionIdentity;
}

export interface CanonicalSessionSelection {
  readonly projectId: string;
  readonly projectPath: string;
  readonly session: Session;
}

export function resolveCanonicalSessionSelection(
  input: CanonicalSelectionInput,
): CanonicalSessionSelection | null {
  if (!input.ready || input.selectedSession?.draft) return null;
  const identity = input.selectedSession
    ? sessionIdentity(input.selectedSession)
    : persistedIdentity(input.persistedSelection);
  if (!identity) return null;
  const resolved = findSession(input.projects, identity);
  if (!resolved) return null;
  if (input.selectedSession
    && input.selectedSession.updatedAt >= resolved.session.updatedAt
    && input.selectedSession.status === resolved.session.status) return null;
  return resolved;
}

export function shouldConsumeCanonicalRestoreIntent(
  input: CanonicalSelectionInput,
): boolean {
  if (!input.ready) return false;
  if (input.selectedSession) return true;
  const sessionId = String(input.persistedSelection.sessionId || '').trim();
  if (!sessionId) return true;
  const projectPath = String(input.persistedSelection.projectPath || '').trim();
  return !projectPath || input.projects.some((project) => project.path === projectPath);
}

interface SessionIdentity {
  readonly id: string;
  readonly provider?: string;
  readonly projectPath?: string;
}

function sessionIdentity(session: Session): SessionIdentity | null {
  const id = session.id.trim();
  if (!id) return null;
  return {
    id,
    provider: session.provider,
    projectPath: String(session.projectPath || '').trim() || undefined,
  };
}

function persistedIdentity(selection: PersistedSessionIdentity): SessionIdentity | null {
  const id = String(selection.sessionId || '').trim();
  if (!id) return null;
  return {
    id,
    provider: String(selection.provider || '').trim() || undefined,
    projectPath: String(selection.projectPath || '').trim() || undefined,
  };
}

function findSession(
  projects: readonly AggregatedProject[],
  identity: SessionIdentity,
): CanonicalSessionSelection | null {
  for (const project of projects) {
    if (identity.projectPath && project.path !== identity.projectPath) continue;
    const session = project.sessions.find((candidate) => (
      candidate.id === identity.id
      && (!identity.provider || candidate.provider === identity.provider)
    ));
    if (session) {
      return { projectId: project.id, projectPath: project.path, session };
    }
  }
  return null;
}
