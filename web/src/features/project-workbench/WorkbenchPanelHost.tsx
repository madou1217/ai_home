import Empty from 'antd/es/empty';
import ShellTerminalPanel from '@/components/chat/ShellTerminalPanel';
import BrowserPanel from './browser/BrowserPanel';
import FilesPanel from './files/FilesPanel';
import ReviewPanel from './review/ReviewPanel';
import type { WorkbenchState } from './workbench-types';
import styles from './project-workbench.module.css';

interface Props {
  state: WorkbenchState;
  projectPath?: string;
  mobile?: boolean;
  onClose: (id: string) => void;
}

export default function WorkbenchPanelHost({ state, projectPath, mobile, onClose }: Props) {
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
            {tab.kind === 'terminal' ? (
              <ShellTerminalPanel visible={active} cwd={projectPath} onClose={() => onClose(tab.id)} />
            ) : null}
            {tab.kind === 'browser' ? <BrowserPanel initialUrl={tab.url} /> : null}
            {tab.kind === 'files' && projectPath ? <FilesPanel projectPath={projectPath} mobile={mobile} /> : null}
            {tab.kind === 'review' && projectPath ? <ReviewPanel projectPath={projectPath} mobile={mobile} /> : null}
          </div>
        );
      })}
    </div>
  );
}
