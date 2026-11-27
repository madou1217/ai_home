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

export interface Requirement {
  id: string;
  title: string;
  description: string;
  status: RequirementStatus;
  priority: number;
  position: number;
  /** /ui/work（Work）里的项目路径或远程工作区影子路径。 */
	workspacePath: string;
	workspaceLabel: string;
	workspaceKind: string;
	assignedProvider: string;
	assignedHarness: string;
	assignedExecution: string;
	assignedServerProfileId: string;
	assignedServerLabel: string;
	assignedAccountRef: string;
	assignedModel: string;
	assignedEffort: string;
	assignedAt: number;
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
  serverProfileId: string;
  serverLabel: string;
  provider: string;
  model: string;
	accountRef: string;
	reasoningEffort: string;
	maxParallel: number;
	updatedAt: number;
}

export interface RequirementSchedulerStatus {
  enabled: boolean;
  serverProfileId: string;
  serverLabel: string;
  provider: string;
  model: string;
	accountRef: string;
	reasoningEffort: string;
	maxParallel: number;
	running: number;
  queued: number;
  ready: number;
  lastRun: number;
  lastError: string;
}

export interface ServerProfileView {
  id: string;
  label: string;
  endpoint: string;
  active: boolean;
}

export interface RequirementSnapshot {
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
  workspacePath?: string;
  workspaceLabel?: string;
  workspaceKind?: string;
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
  workspacePath?: string;
  workspaceLabel?: string;
  workspaceKind?: string;
  mode?: RequirementMode;
  parallel?: boolean;
  steps?: RequirementStep[];
}

export interface RequirementImportInput {
  format: string;
  content: string;
  workspacePath?: string;
  workspaceLabel?: string;
  workspaceKind?: string;
}

/** 与 /ui/work（Work）同源的工作区选项。 */
export interface WorkWorkspaceOption {
  path: string;
  label: string;
  kind: 'local' | 'ssh' | 'connector';
  detail?: string;
}

const BASE = '/webui/requirements';

function snapshotFrom(payload: any): RequirementSnapshot {
  const data = payload?.snapshot || payload || {};
  return {
    requirements: Array.isArray(data.requirements) ? data.requirements : [],
		settings: data.settings || { enabled: true, serverProfileId: '', serverLabel: '', provider: '', model: '', accountRef: '', reasoningEffort: '', maxParallel: 2, updatedAt: 0 },
		scheduler: data.scheduler || { enabled: true, serverProfileId: '', serverLabel: '', provider: '', model: '', accountRef: '', reasoningEffort: '', maxParallel: 2, running: 0, queued: 0, ready: 0, lastRun: 0, lastError: '' },
    generatedAt: Number(data.generatedAt) || Date.now()
  };
}

export const requirementsAPI = {
  load: async (): Promise<RequirementSnapshot> => {
    const response = await api.get(BASE);
    return snapshotFrom(response.data);
  },
  listServers: async (): Promise<ServerProfileView[]> => {
    const response = await api.get(`${BASE}/servers`);
    return Array.isArray(response.data?.servers) ? response.data.servers : [];
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
  refine: async (id: string, workspace?: WorkWorkspaceOption): Promise<Requirement> => {
    const response = await api.post(`${BASE}/${encodeURIComponent(id)}/refine`, {
      workspacePath: workspace?.path || '',
      workspaceLabel: workspace?.label || '',
      workspaceKind: workspace?.kind || ''
    });
    return response.data.requirement as Requirement;
  },
  dispatch: async (id: string, workspace?: WorkWorkspaceOption): Promise<Requirement> => {
    const response = await api.post(`${BASE}/${encodeURIComponent(id)}/dispatch`, {
      workspacePath: workspace?.path || '',
      workspaceLabel: workspace?.label || '',
      workspaceKind: workspace?.kind || ''
    });
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
