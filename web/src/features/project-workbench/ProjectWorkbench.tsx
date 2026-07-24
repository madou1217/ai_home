import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { message } from 'antd';
import type { ReactNode } from 'react';
import WorkbenchTabBar from './WorkbenchTabBar';
import WorkbenchPanelHost from './WorkbenchPanelHost';
import { WorkbenchProvider } from './WorkbenchContext';
import { createInitialState, nextTabId, workbenchReducer } from './workbench-reducer';
import { loadWorkbenchState, saveWorkbenchState } from './workbench-persistence';
import type { WorkbenchPanelKind, WorkbenchTab } from './workbench-types';
import { PANEL_LABELS, PANEL_LIMITS } from './workbench-types';
import styles from './project-workbench.module.css';

interface Props {
  projectPath?: string;
  mobile: boolean;
  chat: ReactNode;
}

function createTab(kind: WorkbenchPanelKind): WorkbenchTab {
  const base = { id: nextTabId(kind), kind, label: PANEL_LABELS[kind], closable: kind !== 'chat' } as const;
  if (kind === 'chat') return { ...base, kind, closable: false };
  if (kind === 'browser') return { ...base, kind, url: 'http://127.0.0.1:9527' };
  if (kind === 'files') return { ...base, kind };
  if (kind === 'terminal') return { ...base, kind };
  return { ...base, kind: 'review' };
}

export default function ProjectWorkbench({ projectPath, mobile, chat }: Props) {
  const [state, dispatch] = useReducer(workbenchReducer, undefined, createInitialState);

  useEffect(() => {
    dispatch({
      type: 'state/reset',
      state: projectPath ? loadWorkbenchState(projectPath) : createInitialState(),
    });
  }, [projectPath]);

  useEffect(() => {
    if (projectPath) saveWorkbenchState(projectPath, state);
  }, [projectPath, state]);

  const openPanel = useCallback((kind: WorkbenchPanelKind) => {
    if (!projectPath && kind !== 'chat') {
      message.warning('请先选择项目');
      return;
    }
    const limit = PANEL_LIMITS[kind];
    if (limit !== undefined && state.tabs.filter((tab) => tab.kind === kind).length >= limit) {
      message.info(`${PANEL_LABELS[kind]}最多打开 ${limit} 个`);
    }
    dispatch({ type: 'tab/add', tab: createTab(kind) });
  }, [projectPath, state.tabs]);

  const actions = useMemo(() => ({ openPanel }), [openPanel]);
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) || state.tabs[0];
  const chatVisible = activeTab.kind === 'chat';
  const toolVisible = !chatVisible;

  return (
    <WorkbenchProvider value={actions}>
      <div className={styles.workbench} data-mobile={mobile}>
        <WorkbenchTabBar
          tabs={state.tabs}
          activeTabId={state.activeTabId}
          onActivate={(id) => dispatch({ type: 'tab/activate', id })}
          onClose={(id) => dispatch({ type: 'tab/close', id })}
          onAdd={openPanel}
        />
        <div className={styles.workspaceStage}>
          <section
            className={`${styles.toolRegion} ${toolVisible ? styles.regionVisible : styles.regionHidden}`}
            aria-hidden={!toolVisible}
            {...(!toolVisible ? { inert: '' } : {})}
          >
            <WorkbenchPanelHost
              state={state}
              projectPath={projectPath}
              mobile={mobile}
              onClose={(id) => dispatch({ type: 'tab/close', id })}
            />
          </section>
          <section
            className={`${styles.chatRegion} ${chatVisible ? styles.regionVisible : styles.regionHidden}`}
            aria-hidden={!chatVisible}
            {...(!chatVisible ? { inert: '' } : {})}
          >
            {chat}
          </section>
        </div>
      </div>
    </WorkbenchProvider>
  );
}
