import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AggregatedProject, Session } from '@/types';
import type { PersistedChatSelection } from '@/features/legacy-chat/runtime-types';
import { resolveCanonicalSessionSelection } from './canonical-session-selection';
import { CanonicalRestoreIntent } from './canonical-restore-intent';

interface CanonicalSessionRestoreInput {
  readonly initialSelection: PersistedChatSelection;
  readonly ready: boolean;
  readonly directoryProjects: readonly AggregatedProject[];
  readonly catalogProjects: readonly AggregatedProject[];
  readonly selectedSession: Session | null;
  readonly setSelectedProject: Dispatch<SetStateAction<AggregatedProject | null>>;
  readonly setSelectedSession: Dispatch<SetStateAction<Session | null>>;
  readonly setExpandedProjects: Dispatch<SetStateAction<Set<string>>>;
}

export function useCanonicalSessionRestore(input: CanonicalSessionRestoreInput): () => void {
  const intentRef = useRef<CanonicalRestoreIntent>();
  if (!intentRef.current) intentRef.current = new CanonicalRestoreIntent(input.initialSelection);

  useEffect(() => {
    const intent = intentRef.current;
    if (!intent) return;
    const resolution = resolveCanonicalSessionSelection({
      ready: input.ready,
      projects: input.directoryProjects,
      selectedSession: input.selectedSession,
      persistedSelection: intent.selection(),
    });
    intent.observe({
      ready: input.ready,
      projects: input.directoryProjects,
      selectedSession: input.selectedSession,
    });
    if (!resolution) return;
    const project = input.catalogProjects.find(({ path }) => path === resolution.projectPath);
    if (!project) return;
    input.setSelectedProject(project);
    input.setSelectedSession(resolution.session);
    input.setExpandedProjects((current) => new Set([...current, project.id]));
  }, [
    input.catalogProjects,
    input.directoryProjects,
    input.ready,
    input.selectedSession,
    input.setExpandedProjects,
    input.setSelectedProject,
    input.setSelectedSession,
  ]);

  return useCallback(() => intentRef.current?.cancel(), []);
}
