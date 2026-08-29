import { memo, useMemo } from 'react';
import { FileOutlined, FolderOutlined } from '@ant-design/icons';
import styles from './chat.module.css';

export interface FileReferenceCandidate {
  name: string;
  path: string;
  type: 'file' | 'folder';
  description?: string;
}

interface Props {
  query: string;
  candidates: FileReferenceCandidate[];
  selectedIndex: number;
  onSelect: (item: FileReferenceCandidate) => void;
  onHoverIndex: (index: number) => void;
  visible: boolean;
}

export const FileReferencePopover = memo(function FileReferencePopover({
  query,
  candidates,
  selectedIndex,
  onSelect,
  onHoverIndex,
  visible,
}: Props) {
  const filtered = useMemo(() => {
    if (!query) return candidates.slice(0, 10);
    const q = query.toLowerCase();
    return candidates
      .filter((c) => c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q))
      .slice(0, 10);
  }, [candidates, query]);

  if (!visible || filtered.length === 0) return null;

  return (
    <div className={styles.slashDropdownMenu} role="listbox" aria-label="File references">
      <div className={styles.slashDropdownHeader}>
        <span>文件引用 @ ({filtered.length})</span>
        <span className={styles.slashDropdownHint}>↑↓ 切换 · Tab / Enter 选择</span>
      </div>
      <div className={styles.slashDropdownViewport}>
        {filtered.map((item, index) => {
          const active = index === selectedIndex;
          return (
            <button
              key={item.path}
              data-index={index}
              type="button"
              role="option"
              aria-selected={active}
              className={`${styles.slashDropdownItem} ${active ? styles.slashDropdownItemActive : ''}`}
              onMouseEnter={() => onHoverIndex(index)}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item);
              }}
            >
              <div className={styles.slashItemIcon}>
                {item.type === 'folder' ? <FolderOutlined /> : <FileOutlined />}
              </div>
              <div className={styles.slashItemContent}>
                <div className={styles.slashItemMain}>
                  <span className={styles.slashItemName}>{item.name}</span>
                </div>
                <div className={styles.slashItemDesc}>
                  {item.path}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
});

export default FileReferencePopover;
