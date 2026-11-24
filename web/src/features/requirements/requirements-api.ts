import api, { guardedWebUiEventSource } from '@/services/api';

export type RequirementStatus =
  | 'idea'
  | 'ready'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'review'
  | 'done'
  | 'blocked'
  | 'archived';

export type RequirementMode = 'plan' | 'goal' | 'loop';

export interface RequirementStep {
  text: string;
  status: 'pending' | 'running' | 'done';
}

export interface RequirementWorkspace {
  id: string;
  name: string;
  projectPaths: string[];
  provider: string;
  model: string;
  accountRef: string;
  maxParallel: number;
  createdAt: number;
  updatedAt: number;
}

export interface Requirement {
  id: string;
  title: string;
  description: string;
  status: RequirementStatus;
  priority: number;
  position: number;
  workspaceId: string;
  mode: RequirementMode;
  parallel: boolean;
  steps: RequirementStep[];
  refinedAt: number;
  progress: number;
  progressNote: string;
  sessionId: string;
  peerMessageId: string;
  turnId: string;
  loopCount: number;
  lastError: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  completedAt: number;
}

export interface RequirementSchedulerSettings {
  enabled: boolean;
  provider: string;
  model: string;
  accountRef: string;
  updatedAt: number;
}

export interface RequirementSchedulerStatus {
  enabled: boolean;
  provider: string;
  model: string;
  accountRef: string;
  running: number;
  queued: number;
  ready: number;
  lastRun: number;
  lastError: string;
}

export interface RequirementSnapshot {
  workspaces: RequirementWorkspace[];
  requirements: Requirement[];
  settings: RequirementSchedulerSettings;
  scheduler: RequirementSchedulerStatus;
  generatedAt: number;
}

export interface RequirementEvent {
  id: string;
  requirementId: string;
  kind: string;
  message: string;
  at: number;
}

export interface RequirementInput {
  title: string;
  description?: string;
  status?: RequirementStatus;
  priority?: number;
  workspaceId?: string;
  mode?: RequirementMode;
  parallel?: boolean;
  steps?: RequirementStep[];
}

export interface RequirementPatch {
  title?: string;
  description?: string;
  status?: RequirementStatus;
  priority?: number;
  position?: number;
  workspaceId?: string;
  mode?: RequirementMode;
  parallel?: boolean;
  steps?: RequirementStep[];
}

export interface RequirementImportInput {
  format: string;
  content: string;
  workspaceId?: string;
}

const BASE = '/webui/requirements';

function snapshotFrom(payload: any): RequirementSnapshot {
  const data = payload?.snapshot || payload || {};
  return {
    workspaces: Array.isArray(data.workspaces) ? data.workspaces : [],
    requirements: Array.isArray(data.requirements) ? data.requirements : [],
    settings: data.settings || { enabled: true, provider: 'agy', model: 'gemini-4-neon-xhigh', accountRef: '', updatedAt: 0 },
    scheduler: data.scheduler || { enabled: true, provider: 'agy', model: 'gemini-4-neon-xhigh', accountRef: '', running: 0, queued: 0, ready: 0, lastRun: 0, lastError: '' },
    generatedAt: Number(data.generatedAt) || Date.now()
  };
}

export const requirementsAPI = {
  load: async (): Promise<RequirementSnapshot> => {
    const response = await api.get(BASE);
    return snapshotFrom(response.data);
  },
  create: async (input: RequirementInput): Promise<Requirement> => {
    const response = await api.post(BASE, input);
    return response.data.requirement as Requirement;
  },
  update: async (id: string, patch: RequirementPatch): Promise<Requirement> => {
    const response = await api.patch(`${BASE}/${encodeURIComponent(id)}`, patch);
    return response.data.requirement as Requirement;
  },
  remove: async (id: string): Promise<void> => {
    await api.delete(`${BASE}/${encodeURIComponent(id)}`);
  },
  refine: async (id: string, workspaceId?: string): Promise<Requirement> => {
    const response = await api.post(`${BASE}/${encodeURIComponent(id)}/refine`, { workspaceId: workspaceId || '' });
    return response.data.requirement as Requirement;
  },
  dispatch: async (id: string, workspaceId?: string): Promise<Requirement> => {
    const response = await api.post(`${BASE}/${encodeURIComponent(id)}/dispatch`, { workspaceId: workspaceId || '' });
    return response.data.requirement as Requirement;
  },
  cancel: async (id: string): Promise<Requirement> => {
    const response = await api.post(`${BASE}/${encodeURIComponent(id)}/cancel`, {});
    return response.data.requirement as Requirement;
  },
  events: async (id: string): Promise<RequirementEvent[]> => {
    const response = await api.get(`${BASE}/${encodeURIComponent(id)}/events`);
    return Array.isArray(response.data.events) ? response.data.events : [];
  },
  import: async (input: RequirementImportInput): Promise<{ count: number; requirements: Requirement[] }> => {
    const response = await api.post(`${BASE}/import`, input);
    return { count: Number(response.data.count) || 0, requirements: response.data.requirements || [] };
  },
  reorder: async (ids: string[]): Promise<RequirementSnapshot> => {
    const response = await api.post(`${BASE}/reorder`, { ids });
    return snapshotFrom(response.data);
  },
  createWorkspace: async (input: Partial<RequirementWorkspace>): Promise<RequirementWorkspace> => {
    const response = await api.post(`${BASE}/workspaces`, input);
    return response.data.workspace as RequirementWorkspace;
  },
  updateWorkspace: async (id: string, input: Partial<RequirementWorkspace>): Promise<RequirementWorkspace> => {
    const response = await api.patch(`${BASE}/workspaces/${encodeURIComponent(id)}`, input);
    return response.data.workspace as RequirementWorkspace;
  },
  removeWorkspace: async (id: string): Promise<void> => {
    await api.delete(`${BASE}/workspaces/${encodeURIComponent(id)}`);
  },
  updateScheduler: async (settings: Partial<RequirementSchedulerSettings>): Promise<RequirementSchedulerSettings> => {
    const response = await api.patch(`${BASE}/scheduler`, settings);
    return response.data.settings as RequirementSchedulerSettings;
  },
  runScheduler: async (): Promise<RequirementSchedulerStatus> => {
    const response = await api.post(`${BASE}/scheduler/run`, {});
    return response.data.status as RequirementSchedulerStatus;
  },
  watch: (handlers: {
    onSnapshot?: (snapshot: RequirementSnapshot) => void;
    onConnected?: () => void;
    onError?: () => void;
  }) => {
    const source = guardedWebUiEventSource('/v0/webui/requirements/watch');
    source.addEventListener('snapshot', (event: MessageEvent) => {
      try {
        handlers.onSnapshot?.(snapshotFrom(JSON.parse(String(event.data || '{}'))));
      } catch {
        handlers.onError?.();
      }
    });
    source.onopen = () => handlers.onConnected?.();
    source.onerror = () => handlers.onError?.();
    return source;
  }
};
