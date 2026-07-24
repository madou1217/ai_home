import { CloseOutlined, PlusOutlined } from '@ant-design/icons';
import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import type { WorkbenchPanelKind, WorkbenchTab, WorkbenchToolKind } from './workbench-types';
import { PANEL_LABELS } from './workbench-types';
import styles from './project-workbench.module.css';

interface Props {
  tabs: readonly WorkbenchTab[];
  activeTabId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: (kind: WorkbenchPanelKind) => void;
}

const ADDABLE: WorkbenchToolKind[] = ['terminal', 'files', 'review', 'browser'];

export default function WorkbenchTabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onAdd,
}: Props) {
  const items: MenuProps['items'] = ADDABLE.map((kind) => ({
    key: kind,
    label: PANEL_LABELS[kind],
    onClick: () => onAdd(kind),
  }));

  return (
    <div className={styles.tabBar} role="tablist" aria-label="项目工具">
      <div className={styles.tabScroller}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTabId}
            className={`${styles.tab} ${tab.id === activeTabId ? styles.tabActive : ''}`}
            onClick={() => onActivate(tab.id)}
          >
            <span className={styles.tabLabel}>{tab.label}</span>
            {tab.closable ? (
              <span
                role="button"
                tabIndex={0}
                className={styles.tabClose}
                aria-label={`关闭${tab.label}`}
                onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    onClose(tab.id);
                  }
                }}
              >
                <CloseOutlined />
              </span>
            ) : null}
          </button>
        ))}
      </div>
      <Dropdown menu={{ items }} trigger={['click']} placement="bottomRight">
        <button type="button" className={styles.addButton} aria-label="添加工具">
          <PlusOutlined />
        </button>
      </Dropdown>
    </div>
  );
}
