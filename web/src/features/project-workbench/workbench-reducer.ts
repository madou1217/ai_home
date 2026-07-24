import type {
  WorkbenchPanelKind,
  WorkbenchState,
  WorkbenchTab,
} from './workbench-types';
import { PANEL_LABELS, PANEL_LIMITS } from './workbench-types';

export type WorkbenchAction =
  | { type: 'tab/add'; tab: WorkbenchTab }
  | { type: 'tab/activate'; id: string }
  | { type: 'tab/close'; id: string }
  | { type: 'tab/update'; id: string; patch: Partial<Pick<WorkbenchTab, 'label'>> & Record<string, unknown> }
  | { type: 'tab/reorder'; fromIndex: number; toIndex: number }
  | { type: 'state/reset'; state: WorkbenchState };

let tabSeq = 0;
export function nextTabId(kind: WorkbenchPanelKind): string {
  return `wb-${kind}-${++tabSeq}`;
}

export function createInitialState(): WorkbenchState {
  const chatTab: WorkbenchTab = {
    id: 'wb-chat-0',
    kind: 'chat',
    label: PANEL_LABELS.chat,
    closable: false,
  };
  return {
    tabs: [chatTab],
    activeTabId: chatTab.id,
  };
}

export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  switch (action.type) {
    case 'tab/add': {
      const kind = action.tab.kind;
      const limit = PANEL_LIMITS[kind];
      if (limit !== undefined) {
        const count = state.tabs.filter((tab) => tab.kind === kind).length;
        if (count >= limit) {
          const existing = state.tabs.find((tab) => tab.kind === kind);
          return existing ? activateTab(state, existing.id) : state;
        }
      }
      if (kind !== 'chat' && kind !== 'terminal' && kind !== 'browser') {
        const existing = state.tabs.find((tab) => tab.kind === kind);
        if (existing) return activateTab(state, existing.id);
      }
      return {
        ...state,
        tabs: [...state.tabs, action.tab],
        activeTabId: action.tab.id,
      };
    }
    case 'tab/activate':
      return state.tabs.some((tab) => tab.id === action.id) ? activateTab(state, action.id) : state;
    case 'tab/close': {
      const target = state.tabs.find((tab) => tab.id === action.id);
      if (!target || !target.closable) return state;
      const next = state.tabs.filter((tab) => tab.id !== action.id);
      const activeTabId = state.activeTabId === action.id
        ? next[Math.max(0, next.length - 1)].id
        : state.activeTabId;
      return activateTab({ ...state, tabs: next }, activeTabId);
    }
    case 'tab/update':
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.id ? { ...tab, ...action.patch } as WorkbenchTab : tab,
        ),
      };
    case 'tab/reorder': {
      const { fromIndex, toIndex } = action;
      if (fromIndex === toIndex) return state;
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, moved);
      return { ...state, tabs };
    }
    case 'state/reset':
      return action.state;
    default:
      return state;
  }
}

function activateTab(state: WorkbenchState, id: string): WorkbenchState {
  const tab = state.tabs.find((candidate) => candidate.id === id);
  if (!tab) return state;
  return { ...state, activeTabId: id };
}
