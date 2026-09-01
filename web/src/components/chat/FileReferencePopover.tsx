import { memo } from 'react';
import { FileOutlined, FolderOutlined, LoadingOutlined } from '@ant-design/icons';
import type { FileReferenceCandidate } from './use-file-reference-candidates';
import styles from './composer/composer.module.css';

export type { FileReferenceCandidate } from './use-file-reference-candidates';

interface Props {
  candidates: FileReferenceCandidate[];
  loading: boolean;
  fetchError: string | null;
  hasProject: boolean;
  selectedIndex: number;
  onSelect: (item: FileReferenceCandidate) => void;
  onHoverIndex: (index: number) => void;
  visible: boolean;
}

/**
 * @ 文件引用下拉（受控渲染层）：候选数据由 useFileReferenceCandidates 提供，
 * 父组件持有 selectedIndex 以支持键盘 ↑↓ / Tab / Enter 导航。
 */
export const FileReferencePopover = memo(function FileReferencePopover({
  candidates,
  loading,
  fetchError,
  hasProject,
  selectedIndex,
  onSelect,
  onHoverIndex,
  visible,
}: Props) {
  if (!visible) return null;

  return (
    <div className={styles.slashDropdownMenu} role="listbox" aria-label="File references">
      <div className={styles.slashDropdownHeader}>
        <span>
          文件引用 @ {loading ? <LoadingOutlined style={{ marginLeft: 4 }} /> : `(${candidates.length})`}
        </span>
        <span className={styles.slashDropdownHint}>
          {fetchError ? <span style={{ color: '#ef4444' }}>{fetchError}</span> : '↑↓ 切换 · Tab / Enter 选择'}
        </span>
      </div>
      <div className={styles.slashDropdownViewport}>
        {candidates.length === 0 && !loading ? (
          <div style={{ padding: '12px 14px', fontSize: 12, color: '#94a3b8' }}>
            {hasProject ? (fetchError ? '无法读取项目目录' : '未找到匹配的工程文件') : '纯聊模式不支持 @ 文件引用'}
          </div>
        ) : (
          candidates.map((item, index) => {
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
                  {item.type === 'folder' ? <FolderOutlined style={{ color: '#0d9488' }} /> : <FileOutlined />}
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
          })
        )}
      </div>
    </div>
  );
});

export default FileReferencePopover;
