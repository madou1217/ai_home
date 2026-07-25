import {
  createInitialWorkbenchState,
  nextWorkbenchTabId,
} from './workbench-state-policy.js';

const STORAGE_PREFIX = 'aih:workbench:';
const SCHEMA_VERSION = 3;
const RESTORED_TAB_LIMIT = 24;
const RESTORABLE_KINDS = new Set(['browser', 'files', 'review']);

export function workbenchProjectStorageKey(projectPath) {
  const path = String(projectPath || '');
  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = ((hash << 5) - hash + path.charCodeAt(index)) | 0;
  }
  return `${STORAGE_PREFIX}${(hash >>> 0).toString(36)}`;
}

export function serializeWorkbenchState(state) {
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  return JSON.stringify({
    v: SCHEMA_VERSION,
    tabs: state.tabs.map((tab) => ({
      kind: tab.kind,
      label: tab.label,
      ...(tab.kind === 'files' ? { filePath: tab.filePath } : {}),
      ...(tab.kind === 'browser' ? { url: tab.url } : {}),
    })),
    activeKind: activeTab?.kind ?? 'chat',
  });
}

export function restoreWorkbenchState(data) {
  if (!data
    || ![1, 2, SCHEMA_VERSION].includes(data.v)
    || !Array.isArray(data.tabs)) {
    return createInitialWorkbenchState();
  }
  const base = createInitialWorkbenchState();
  const restored = data.tabs
    .filter((entry) => entry && RESTORABLE_KINDS.has(entry.kind))
    .slice(0, RESTORED_TAB_LIMIT)
    .map(restoreTab);
  const tabs = [...base.tabs, ...restored];
  const activeKind = data.activeKind === 'side-chat' ? 'chat' : data.activeKind;
  const activeTab = tabs.find((tab) => tab.kind === activeKind) || tabs[0];
  return {
    tabs,
    activeTabId: activeTab.id,
  };
}

function restoreTab(entry) {
  const common = {
    id: nextWorkbenchTabId(entry.kind),
    label: String(entry.label || entry.kind).slice(0, 80),
    closable: true,
  };
  if (entry.kind === 'browser') {
    return {
      ...common,
      kind: 'browser',
      url: entry.url || 'http://127.0.0.1:9527',
    };
  }
  if (entry.kind === 'files') {
    return { ...common, kind: 'files', filePath: entry.filePath };
  }
  return { ...common, kind: 'review' };
}
