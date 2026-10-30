import Empty from 'antd/es/empty';
import BrowserPanel from './browser/BrowserPanel';
import FilesPanel from './files/FilesPanel';
import ReviewPanel from './review/ReviewPanel';
import type { WorkbenchState, WorkbenchWorkspaceDescriptor } from './workbench-types';
import styles from './project-workbench.module.css';

interface Props {
  state: WorkbenchState;
  projectPath?: string;
  workspace?: WorkbenchWorkspaceDescriptor;
  mobile?: boolean;
  onClose: (id: string) => void;
}

// 终端不在这里渲染：Work 的终端统一由全局 Web Terminal 浮窗承载。
export default function WorkbenchPanelHost({ state, projectPath, mobile }: Props) {
  const toolTabs = state.tabs.filter((tab) => tab.kind !== 'chat');
  if (toolTabs.length === 0) return <Empty description="请从上方添加项目工具" />;

  return (
    <div className={styles.panelHost}>
      {toolTabs.map((tab) => {
        const active = tab.id === state.activeTabId;
        return (
          <div
            key={tab.id}
            className={`${styles.panel} ${active ? styles.panelActive : ''}`}
            aria-hidden={!active}
            {...(!active ? { inert: '' } : {})}
          >
            {tab.kind === 'browser' ? <BrowserPanel initialUrl={tab.url} /> : null}
            {tab.kind === 'files' && projectPath ? <FilesPanel projectPath={projectPath} mobile={mobile} /> : null}
            {tab.kind === 'review' && projectPath ? <ReviewPanel projectPath={projectPath} mobile={mobile} /> : null}
          </div>
        );
      })}
    </div>
  );
}
