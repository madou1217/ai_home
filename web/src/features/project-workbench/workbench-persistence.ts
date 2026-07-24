import type { WorkbenchPanelKind, WorkbenchState, WorkbenchTab } from './workbench-types';
import { createInitialState, nextTabId } from './workbench-reducer';

const STORAGE_PREFIX = 'aih:workbench:';
const SCHEMA_VERSION = 3;

type PersistedKind = WorkbenchPanelKind | 'side-chat';

interface Persisted {
  v: number;
  tabs: Array<{ kind: PersistedKind; label: string; filePath?: string; url?: string }>;
  activeKind: PersistedKind;
}

function projectKey(projectPath: string): string {
  let hash = 0;
  for (let index = 0; index < projectPath.length; index++) {
    hash = ((hash << 5) - hash + projectPath.charCodeAt(index)) | 0;
  }
  return `${STORAGE_PREFIX}${(hash >>> 0).toString(36)}`;
}

export function saveWorkbenchState(projectPath: string, state: WorkbenchState): void {
  try {
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    const persisted: Persisted = {
      v: SCHEMA_VERSION,
      tabs: state.tabs.map((tab) => {
        const entry: Persisted['tabs'][number] = { kind: tab.kind, label: tab.label };
        if (tab.kind === 'files') entry.filePath = tab.filePath;
        if (tab.kind === 'browser') entry.url = tab.url;
        return entry;
      }),
      activeKind: activeTab?.kind ?? 'chat',
    };
    window.localStorage.setItem(projectKey(projectPath), JSON.stringify(persisted));
  } catch { /* quota exceeded or private mode */ }
}

export function loadWorkbenchState(projectPath: string): WorkbenchState {
  try {
    const raw = window.localStorage.getItem(projectKey(projectPath));
    if (!raw) return createInitialState();
    const data = JSON.parse(raw) as Persisted;
    if (![1, 2, SCHEMA_VERSION].includes(data.v) || !Array.isArray(data.tabs)) {
      return createInitialState();
    }
    const base = createInitialState();
    const restored = data.tabs
      .filter((entry) => entry && entry.kind !== 'chat' && entry.kind !== 'terminal' && entry.kind !== 'side-chat')
      .slice(0, 24)
      .map(restoreTab)
      .filter((tab): tab is WorkbenchTab => tab !== null);
    const tabs = [...base.tabs, ...restored];
    const activeKind = data.activeKind === 'side-chat' ? 'chat' : data.activeKind;
    const activeTab = tabs.find((tab) => tab.kind === activeKind) || tabs[0];
    return {
      tabs,
      activeTabId: activeTab.id,
    };
  } catch {
    return createInitialState();
  }
}

function restoreTab(entry: Persisted['tabs'][number]): WorkbenchTab | null {
  const kind = entry.kind;
  if (kind === 'chat' || kind === 'terminal' || kind === 'side-chat') return null;
  const common = {
    id: nextTabId(kind),
    label: String(entry.label || kind).slice(0, 80),
    closable: true as const,
  };
  if (kind === 'browser') {
    return { ...common, kind, url: entry.url || 'http://127.0.0.1:9527' };
  }
  if (kind === 'files') return { ...common, kind, filePath: entry.filePath };
  if (kind === 'review') return { ...common, kind };
  return null;
}

export function clearWorkbenchState(projectPath: string): void {
  try {
    window.localStorage.removeItem(projectKey(projectPath));
  } catch { /* ignore */ }
}
