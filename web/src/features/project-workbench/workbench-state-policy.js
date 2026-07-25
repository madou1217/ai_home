export const PANEL_LABELS = Object.freeze({
  chat: '会话',
  terminal: '终端',
  files: '文件',
  review: '变更',
  browser: '浏览器',
});

export const PANEL_LIMITS = Object.freeze({
  terminal: 4,
  browser: 3,
  files: 20,
});

let tabSequence = 0;

export function nextWorkbenchTabId(kind) {
  tabSequence += 1;
  return `wb-${kind}-${tabSequence}`;
}

export function createInitialWorkbenchState() {
  const chatTab = {
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

export function reduceWorkbenchState(state, action) {
  switch (action.type) {
    case 'tab/add':
      return addTab(state, action.tab);
    case 'tab/activate':
      return state.tabs.some((tab) => tab.id === action.id)
        ? activateTab(state, action.id)
        : state;
    case 'tab/close':
      return closeTab(state, action.id);
    case 'tab/update':
      return {
        ...state,
        tabs: state.tabs.map((tab) => (
          tab.id === action.id ? { ...tab, ...action.patch } : tab
        )),
      };
    case 'tab/reorder':
      return reorderTabs(state, action.fromIndex, action.toIndex);
    case 'state/reset':
      return action.state;
    default:
      return state;
  }
}

function addTab(state, tab) {
  const limit = PANEL_LIMITS[tab.kind];
  if (limit !== undefined) {
    const existingTabs = state.tabs.filter((item) => item.kind === tab.kind);
    if (existingTabs.length >= limit) {
      return activateTab(state, existingTabs[0].id);
    }
  }
  if (tab.kind !== 'chat' && tab.kind !== 'terminal' && tab.kind !== 'browser') {
    const existing = state.tabs.find((item) => item.kind === tab.kind);
    if (existing) return activateTab(state, existing.id);
  }
  return {
    ...state,
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
  };
}

function closeTab(state, id) {
  const target = state.tabs.find((tab) => tab.id === id);
  if (!target || !target.closable) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeTabId = state.activeTabId === id
    ? tabs[Math.max(0, tabs.length - 1)].id
    : state.activeTabId;
  return activateTab({ ...state, tabs }, activeTabId);
}

function reorderTabs(state, fromIndex, toIndex) {
  if (fromIndex === toIndex) return state;
  if (!Number.isInteger(fromIndex)
    || !Number.isInteger(toIndex)
    || fromIndex < 0
    || toIndex < 0
    || fromIndex >= state.tabs.length
    || toIndex >= state.tabs.length) {
    return state;
  }
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(fromIndex, 1);
  tabs.splice(toIndex, 0, moved);
  return { ...state, tabs };
}

function activateTab(state, id) {
  return state.tabs.some((tab) => tab.id === id)
    ? { ...state, activeTabId: id }
    : state;
}
