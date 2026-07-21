import type {
  Dispatch,
  MutableRefObject,
  SetStateAction,
} from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { message } from 'antd';
import { sessionsAPI } from '@/services/api';
import {
  CHAT_PROJECT_SESSIONS_LOAD_MESSAGE_KEY,
  clearLoadFailureMessage,
  showLoadFailureMessage,
} from '@/services/load-failure-message.js';
import {
  applyProjectSessionHydrationResponse,
  canApplyProjectSessionHydration,
  isHydratedProjectSessionsStale,
  isProjectSessionSnapshotComplete,
  preserveHydratedProjectSessions,
  shouldHydrateProjectSessions,
} from '@/services/project-session-hydration.js';
import type { AggregatedProject, Session } from '@/types';
import {
  projectHydrationServerKey,
  readCachedProjects,
  writeCachedProjects,
} from './chat-cache';
import {
  buildDisplayProjects,
  findProjectBySessionId,
  normalizeProjectCatalog,
} from './project-selection-policy';
import type { PersistedChatSelection } from './runtime-types';
import { useProjectCatalogTransport } from './use-project-catalog-transport';

export interface ProjectCatalog {
  readonly projects: AggregatedProject[];
  readonly displayProjects: AggregatedProject[];
  readonly selectedProject: AggregatedProject | null;
  readonly selectedSession: Session | null;
  readonly selectedSessionRef: MutableRefObject<Session | null>;
  readonly expandedProjects: Set<string>;
  readonly hydratingProjectPaths: Set<string>;
  readonly passiveRunningSessionKeys: Set<string>;
  readonly loadingProjects: boolean;
  readonly setSelectedProject: Dispatch<SetStateAction<AggregatedProject | null>>;
  readonly setSelectedSession: Dispatch<SetStateAction<Session | null>>;
  readonly setExpandedProjects: Dispatch<SetStateAction<Set<string>>>;
  readonly toggleProject: (projectId: string) => void;
  readonly findProjectByPath: (projectPath?: string) => AggregatedProject | null;
  readonly hydrateProjectSessions: (
    projectPath: string,
    selection?: PersistedChatSelection,
    force?: boolean,
  ) => Promise<void>;
  readonly loadProjects: (selection?: PersistedChatSelection) => Promise<void>;
  readonly pauseProjectWatch: () => void;
  readonly resumeProjectWatch: () => void;
}

export function useProjectCatalog(
  initialSelection: PersistedChatSelection = {},
): ProjectCatalog {
  const stableInitialSelection = useRef(initialSelection).current;
  const [initialProjects] = useState<AggregatedProject[]>(readCachedProjects);
  const [initialHydratedProjects] = useState(() => new Map(
    initialProjects
      .filter((project) => isProjectSessionSnapshotComplete(project))
      .map((project) => [project.path, project]),
  ));
  const [initialServerKey] = useState(projectHydrationServerKey);
  const [projects, setProjects] = useState<AggregatedProject[]>(initialProjects);
  const [selectedProject, setSelectedProject] = useState<AggregatedProject | null>(null);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [hydratingProjectPaths, setHydratingProjectPaths] = useState<Set<string>>(new Set());
  const [passiveRunningSessionKeys, setPassiveRunningSessionKeys] = useState<Set<string>>(new Set());
  const [loadingProjects, setLoadingProjects] = useState(false);

  const selectedSessionRef = useRef<Session | null>(null);
  const selectedProjectRef = useRef<AggregatedProject | null>(null);
  const activeRef = useRef(true);
  const projectsRef = useRef<AggregatedProject[]>(projects);
  const hydratedProjectsRef = useRef<Map<string, AggregatedProject>>(initialHydratedProjects);
  const hydrationServerKeyRef = useRef(initialServerKey);
  const staleHydratedPathsRef = useRef<Set<string>>(new Set());
  const snapshotGenerationRef = useRef(0);
  const hydrationSequenceRef = useRef(0);
  const latestHydrationRef = useRef<Map<string, number>>(new Map());
  const inflightHydrationRef = useRef<Map<string, Promise<void>>>(new Map());
  const hydrationSelectionRef = useRef<Map<string, PersistedChatSelection>>(new Map());
  const hydrateRef = useRef<ProjectCatalog['hydrateProjectSessions']>(async () => {});

  useLayoutEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [
    selectedSession?.provider,
    selectedSession?.id,
    selectedSession?.projectDirName,
    selectedSession?.draft,
  ]);
  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  const resetHydration = useCallback((serverKey: string): void => {
    hydrationServerKeyRef.current = serverKey;
    hydratedProjectsRef.current.clear();
    staleHydratedPathsRef.current.clear();
    latestHydrationRef.current.clear();
    inflightHydrationRef.current.clear();
    hydrationSelectionRef.current.clear();
    setHydratingProjectPaths(new Set());
  }, []);

  const applyProjectSnapshot = useCallback((
    items: AggregatedProject[],
    selection: PersistedChatSelection = {},
    skipHydration = false,
  ): AggregatedProject[] => {
    snapshotGenerationRef.current += 1;
    const currentServerKey = projectHydrationServerKey();
    if (hydrationServerKeyRef.current !== currentServerKey) resetHydration(currentServerKey);

    const compactProjects = normalizeProjectCatalog(items);
    const newlyStalePaths = markStaleHydratedProjects(
      compactProjects,
      hydratedProjectsRef.current,
      staleHydratedPathsRef.current,
    );
    const nextProjects = preserveHydratedProjectSessions(
      compactProjects,
      hydratedProjectsRef.current,
    ) as AggregatedProject[];
    reconcileHydratedProjects(
      nextProjects,
      hydratedProjectsRef.current,
      staleHydratedPathsRef.current,
    );
    writeCachedProjects(nextProjects);
    projectsRef.current = nextProjects;
    setProjects(nextProjects);
    if (!skipHydration) {
      newlyStalePaths.forEach((projectPath) => {
        hydrateRef.current(projectPath, { projectPath }, true).catch(() => {});
      });
    }
    applySelection({
      projects: nextProjects,
      selection,
      skipHydration,
      selectedProjectRef,
      selectedSessionRef,
      setExpandedProjects,
      setSelectedProject,
      setSelectedSession,
      hydrate: hydrateRef.current,
    });
    return nextProjects;
  }, [resetHydration]);

  const hydrateProjectSessions = useCallback(async (
    projectPath: string,
    selection: PersistedChatSelection = {},
    force = false,
  ): Promise<void> => {
    const normalizedPath = String(projectPath || '').trim();
    if (!normalizedPath) return;
    const currentProject = projectsRef.current.find((project) => project.path === normalizedPath);
    const hydrationIsStale = staleHydratedPathsRef.current.has(normalizedPath);
    if (!currentProject
      || (!force && !hydrationIsStale && !shouldHydrateProjectSessions(currentProject, selection))) {
      return;
    }

    const serverKey = projectHydrationServerKey();
    if (hydrationServerKeyRef.current !== serverKey) {
      resetHydration(serverKey);
      return;
    }
    const requestKey = `${serverKey}\u0000${normalizedPath}`;
    rememberHydrationSelection(hydrationSelectionRef.current, requestKey, normalizedPath, selection);
    const inflight = inflightHydrationRef.current.get(requestKey);
    if (inflight) return inflight;

    const requestId = ++hydrationSequenceRef.current;
    const snapshotGeneration = snapshotGenerationRef.current;
    latestHydrationRef.current.set(normalizedPath, requestId);
    setHydratingProjectPaths((current) => new Set([...current, normalizedPath]));

    let retryForNewerSnapshot = false;
    const request = (async () => {
      try {
        const hydratedProject = await sessionsAPI.getProjectSessions(normalizedPath);
        if (!activeRef.current) return;
        const currentServerKey = projectHydrationServerKey();
        if (!canApplyProjectSessionHydration({
          requestId,
          latestRequestId: latestHydrationRef.current.get(normalizedPath),
          serverKey,
          currentServerKey,
          projectPath: normalizedPath,
          responseProjectPath: hydratedProject?.path,
          currentProjectPaths: new Set(projectsRef.current.map((project) => project.path)),
        })) return;
        if (snapshotGenerationRef.current !== snapshotGeneration) {
          retryForNewerSnapshot = true;
          return;
        }

        const latestProject = projectsRef.current.find((project) => project.path === normalizedPath);
        if (!latestProject) return;
        const mergedProject = applyProjectSessionHydrationResponse(
          latestProject,
          hydratedProject,
        ) as AggregatedProject;
        staleHydratedPathsRef.current.delete(normalizedPath);
        hydratedProjectsRef.current.set(normalizedPath, mergedProject);
        const nextProjects = projectsRef.current.map((project) => (
          project.path === normalizedPath ? mergedProject : project
        ));
        const pendingSelection = hydrationSelectionRef.current.get(requestKey) || selection;
        hydrationSelectionRef.current.delete(requestKey);
        clearLoadFailureMessage(message, CHAT_PROJECT_SESSIONS_LOAD_MESSAGE_KEY);
        applyProjectSnapshot(nextProjects, pendingSelection, true);
      } catch (_error) {
        if (activeRef.current
          && latestHydrationRef.current.get(normalizedPath) === requestId
          && projectHydrationServerKey() === serverKey) {
          showLoadFailureMessage(
            message,
            CHAT_PROJECT_SESSIONS_LOAD_MESSAGE_KEY,
            '加载完整会话列表失败，请再次展开项目重试',
          );
        }
      } finally {
        if (activeRef.current && latestHydrationRef.current.get(normalizedPath) === requestId) {
          setHydratingProjectPaths((current) => {
            const next = new Set(current);
            next.delete(normalizedPath);
            return next;
          });
        }
      }
    })();

    inflightHydrationRef.current.set(requestKey, request);
    try {
      await request;
    } finally {
      if (inflightHydrationRef.current.get(requestKey) === request) {
        inflightHydrationRef.current.delete(requestKey);
      }
      if (activeRef.current && retryForNewerSnapshot) {
        window.setTimeout(() => {
          if (!activeRef.current) return;
          const pendingSelection = hydrationSelectionRef.current.get(requestKey) || selection;
          hydrateRef.current(normalizedPath, pendingSelection, true).catch(() => {});
        }, 0);
      }
    }
  }, [applyProjectSnapshot, resetHydration]);
  hydrateRef.current = hydrateProjectSessions;
  const {
    loadProjects,
    pauseProjectWatch,
    resumeProjectWatch,
  } = useProjectCatalogTransport({
    activeRef,
    initialSelection: stableInitialSelection,
    applyProjectSnapshot,
    setLoadingProjects,
    setPassiveRunningSessionKeys,
  });

  const toggleProject = useCallback((projectId: string): void => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);
  const findProjectByPath = useCallback((projectPath?: string): AggregatedProject | null => (
    projectsRef.current.find((project) => project.path === projectPath) || null
  ), []);
  const displayProjects = useMemo(
    () => buildDisplayProjects(projects, selectedProject, selectedSession),
    [projects, selectedProject, selectedSession],
  );

  return {
    projects,
    displayProjects,
    selectedProject,
    selectedSession,
    selectedSessionRef,
    expandedProjects,
    hydratingProjectPaths,
    passiveRunningSessionKeys,
    loadingProjects,
    setSelectedProject,
    setSelectedSession,
    setExpandedProjects,
    toggleProject,
    findProjectByPath,
    hydrateProjectSessions,
    loadProjects,
    pauseProjectWatch,
    resumeProjectWatch,
  };
}

function markStaleHydratedProjects(
  projects: AggregatedProject[],
  hydratedProjects: Map<string, AggregatedProject>,
  stalePaths: Set<string>,
): string[] {
  const newlyStalePaths: string[] = [];
  projects.forEach((project) => {
    const hydratedProject = hydratedProjects.get(project.path);
    if (!hydratedProject) return;
    if (isProjectSessionSnapshotComplete(project)) {
      stalePaths.delete(project.path);
    } else if (isHydratedProjectSessionsStale(project, hydratedProject)
      && !stalePaths.has(project.path)) {
      stalePaths.add(project.path);
      newlyStalePaths.push(project.path);
    }
  });
  return newlyStalePaths;
}

function reconcileHydratedProjects(
  projects: AggregatedProject[],
  hydratedProjects: Map<string, AggregatedProject>,
  stalePaths: Set<string>,
): void {
  const visiblePaths = new Set(projects.map((project) => project.path));
  for (const projectPath of hydratedProjects.keys()) {
    if (!visiblePaths.has(projectPath)) {
      hydratedProjects.delete(projectPath);
      stalePaths.delete(projectPath);
    }
  }
  projects.forEach((project) => {
    if (hydratedProjects.has(project.path)) hydratedProjects.set(project.path, project);
  });
}

function rememberHydrationSelection(
  selections: Map<string, PersistedChatSelection>,
  requestKey: string,
  projectPath: string,
  selection: PersistedChatSelection,
): void {
  if (!selection.sessionId && !selection.projectPath) return;
  selections.set(requestKey, {
    ...selections.get(requestKey),
    ...selection,
    projectPath,
  });
}

interface ApplySelectionOptions {
  readonly projects: AggregatedProject[];
  readonly selection: PersistedChatSelection;
  readonly skipHydration: boolean;
  readonly selectedProjectRef: MutableRefObject<AggregatedProject | null>;
  readonly selectedSessionRef: MutableRefObject<Session | null>;
  readonly setExpandedProjects: Dispatch<SetStateAction<Set<string>>>;
  readonly setSelectedProject: Dispatch<SetStateAction<AggregatedProject | null>>;
  readonly setSelectedSession: Dispatch<SetStateAction<Session | null>>;
  readonly hydrate: ProjectCatalog['hydrateProjectSessions'];
}

function applySelection(options: ApplySelectionOptions): void {
  const currentSession = options.selectedSessionRef.current;
  const selection = {
    sessionId: options.selection.sessionId || (!currentSession?.draft ? currentSession?.id : undefined),
    provider: options.selection.provider || currentSession?.provider,
    projectDirName: options.selection.projectDirName || currentSession?.projectDirName,
    projectPath: options.selection.projectPath
      || currentSession?.projectPath
      || options.selectedProjectRef.current?.path,
  };
  const matched = findProjectBySessionId(options.projects, selection);
  if (matched) {
    selectMatchedSession(options, selection, matched);
    return;
  }
  selectProjectPath(options, selection, currentSession);
}

function selectMatchedSession(
  options: ApplySelectionOptions,
  selection: PersistedChatSelection,
  matched: { project: AggregatedProject; session: Session },
): void {
  if (!options.skipHydration && shouldHydrateProjectSessions(matched.project, selection)) {
    options.hydrate(matched.project.path, selection).catch(() => {});
  }
  if (options.selection.sessionId) {
    options.setExpandedProjects((current) => new Set([...current, matched.project.id]));
  }
  options.setSelectedProject(matched.project);
  options.setSelectedSession((previous) => samePersistedSession(previous, matched.session)
    ? previous
    : matched.session);
}

function selectProjectPath(
  options: ApplySelectionOptions,
  selection: PersistedChatSelection,
  currentSession: Session | null,
): void {
  if (!selection.projectPath) return;
  const project = options.projects.find((item) => item.path === selection.projectPath) || null;
  if (project) {
    if (!options.skipHydration && shouldHydrateProjectSessions(project, selection)) {
      options.hydrate(project.path, selection).catch(() => {});
    }
    if (options.selection.projectPath) {
      options.setExpandedProjects((current) => new Set([...current, project.id]));
    }
  } else if (currentSession?.draft) {
    return;
  }
  options.setSelectedProject(project);
  if (currentSession?.draft && currentSession.projectPath !== selection.projectPath) {
    options.setSelectedSession({ ...currentSession, projectPath: selection.projectPath });
  }
}

function samePersistedSession(previous: Session | null, next: Session): boolean {
  return Boolean(previous
    && previous.id === next.id
    && previous.provider === next.provider
    && previous.projectDirName === next.projectDirName
    && !previous.draft);
}
