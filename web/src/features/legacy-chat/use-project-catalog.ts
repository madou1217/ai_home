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

  const clearHydratingPath = useCallback((projectPath: string): void => {
    setHydratingProjectPaths((current) => {
      if (!current.has(projectPath)) return current;
      const next = new Set(current);
      next.delete(projectPath);
      return next;
    });
  }, []);

  const hydrateProjectSessions = useCallback(async (
    projectPath: string,
    selection: PersistedChatSelection = {},
    force = false,
  ): Promise<void> => {
    if (!projectPath) return;
    const currentProjects = projectsRef.current;
    const project = currentProjects.find((candidate) => candidate.path === projectPath);
    if (!project) return;
    if (!force && !shouldHydrateProjectSessions(
      project,
      staleHydratedPathsRef.current.has(projectPath),
    )) {
      return;
    }

    if (selection.sessionId || selection.projectDirName) {
      hydrationSelectionRef.current.set(projectPath, selection);
    }
    const inflight = inflightHydrationRef.current.get(projectPath);
    if (inflight) return inflight;

    const requestGeneration = snapshotGenerationRef.current;
    const hydrationId = ++hydrationSequenceRef.current;
    latestHydrationRef.current.set(projectPath, hydrationId);
    setHydratingProjectPaths((current) => new Set([...current, projectPath]));

    const task = (async () => {
      try {
        const hydratedProject = await sessionsAPI.getProjectSessions(projectPath);
        if (!activeRef.current) return;
        if (latestHydrationRef.current.get(projectPath) !== hydrationId) return;
        if (!canApplyProjectSessionHydration(requestGeneration, snapshotGenerationRef.current)) {
          staleHydratedPathsRef.current.add(projectPath);
          return;
        }

        staleHydratedPathsRef.current.delete(projectPath);
        hydratedProjectsRef.current.set(projectPath, hydratedProject);
        setProjects((latest) => {
          const applied = applyProjectSessionHydrationResponse(latest, hydratedProject);
          const normalized = normalizeProjectCatalog(applied);
          projectsRef.current = normalized;
          writeCachedProjects(normalized);
          return normalized;
        });
        clearLoadFailureMessage(message, CHAT_PROJECT_SESSIONS_LOAD_MESSAGE_KEY);

        const targetSelection = hydrationSelectionRef.current.get(projectPath) || selection;
        if (targetSelection.sessionId) {
          const match = hydratedProject.sessions.find(
            (s) => s.id === targetSelection.sessionId,
          );
          if (match && selectedSessionRef.current?.id === targetSelection.sessionId) {
            setSelectedSession(match);
          }
        }
      } catch (_error) {
        if (!activeRef.current) return;
        if (latestHydrationRef.current.get(projectPath) !== hydrationId) return;
        showLoadFailureMessage(
          message,
          CHAT_PROJECT_SESSIONS_LOAD_MESSAGE_KEY,
          '加载完整会话列表失败',
        );
      } finally {
        inflightHydrationRef.current.delete(projectPath);
        hydrationSelectionRef.current.delete(projectPath);
        clearHydratingPath(projectPath);
      }
    })();

    inflightHydrationRef.current.set(projectPath, task);
    return task;
  }, [clearHydratingPath]);
  hydrateRef.current = hydrateProjectSessions;

  const toggleProject = useCallback((projectId: string): void => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
    const target = projectsRef.current.find((candidate) => candidate.id === projectId);
    if (target) void hydrateRef.current(target.path);
  }, []);

  const findProjectByPath = useCallback((projectPath?: string): AggregatedProject | null => {
    if (!projectPath) return null;
    return projectsRef.current.find((candidate) => candidate.path === projectPath) || null;
  }, []);

  const applyProjectSnapshot = useCallback((
    incomingProjects: AggregatedProject[],
    selection: PersistedChatSelection = {},
  ): AggregatedProject[] => {
    snapshotGenerationRef.current += 1;
    const activeServerKey = projectHydrationServerKey();
    if (hydrationServerKeyRef.current !== activeServerKey) {
      resetHydration(activeServerKey);
    }

    const currentHydrated = hydratedProjectsRef.current;
    const normalizedIncoming = normalizeProjectCatalog(incomingProjects);
    const mergedProjects = normalizeProjectCatalog(
      preserveHydratedProjectSessions(normalizedIncoming, currentHydrated),
    );
    projectsRef.current = mergedProjects;
    setProjects(mergedProjects);
    writeCachedProjects(mergedProjects);

    // Reconcile selection
    const targetSelection = selection.sessionId ? selection : {
      sessionId: selectedSessionRef.current?.id,
      provider: selectedSessionRef.current?.provider,
      projectPath: selectedSessionRef.current?.projectPath || selectedProjectRef.current?.path,
      projectDirName: selectedSessionRef.current?.projectDirName,
    };

    if (targetSelection.sessionId) {
      const found = findProjectBySessionId(mergedProjects, targetSelection);
      if (found) {
        setSelectedProject(found.project);
        setSelectedSession(found.session);
        setExpandedProjects((curr) => new Set([...curr, found.project.id]));
      }
    } else if (targetSelection.projectPath) {
      const foundProject = mergedProjects.find((p) => p.path === targetSelection.projectPath);
      if (foundProject) {
        setSelectedProject(foundProject);
      }
    }

    return mergedProjects;
  }, [resetHydration]);

  const transport = useProjectCatalogTransport({
    activeRef,
    initialSelection: stableInitialSelection,
    applyProjectSnapshot,
    setLoadingProjects,
    setPassiveRunningSessionKeys,
  });

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
    loadProjects: transport.loadProjects,
    pauseProjectWatch: transport.pauseProjectWatch,
    resumeProjectWatch: transport.resumeProjectWatch,
  };
}
