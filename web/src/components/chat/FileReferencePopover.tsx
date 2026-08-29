import { memo, useMemo, useEffect, useState } from 'react';
import { FileOutlined, FolderOutlined, LoadingOutlined } from '@ant-design/icons';
import { fsAPI } from '@/services/api';
import styles from './chat.module.css';

export interface FileReferenceCandidate {
  name: string;
  path: string;
  type: 'file' | 'folder';
  description?: string;
}

interface Props {
  query: string;
  projectPath?: string;
  selectedIndex: number;
  onSelect: (item: FileReferenceCandidate) => void;
  onHoverIndex: (index: number) => void;
  visible: boolean;
}

export const FileReferencePopover = memo(function FileReferencePopover({
  query,
  projectPath,
  selectedIndex,
  onSelect,
  onHoverIndex,
  visible,
}: Props) {
  const [remoteCandidates, setRemoteCandidates] = useState<FileReferenceCandidate[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !projectPath) return;
    let cancelled = false;
    setLoading(true);

    // 异步拉取当前工作区项目的文件目录树，支持 @ 动态深度搜索
    fsAPI.getTree(projectPath)
      .then((res: any) => {
        if (cancelled) return;
        const list: FileReferenceCandidate[] = [];
        const traverse = (node: any, currentPath = '') => {
          if (!node) return;
          const name = node.name || node.title || '';
          const relPath = currentPath ? `${currentPath}/${name}` : name;
          const isDir = Boolean(node.isDir || node.children);
          if (name && !name.startsWith('.') && name !== 'node_modules' && name !== 'dist') {
            list.push({
              name,
              path: relPath,
              type: isDir ? 'folder' : 'file',
            });
          }
          if (Array.isArray(node.children)) {
            node.children.forEach((c: any) => traverse(c, relPath));
          }
        };

        if (Array.isArray(res?.data?.children || res?.children)) {
          (res.data?.children || res.children).forEach((c: any) => traverse(c));
        } else if (Array.isArray(res?.data || res)) {
          (res.data || res).forEach((c: any) => traverse(c));
        }
        setRemoteCandidates(list);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [projectPath, visible]);

  const filtered = useMemo(() => {
    const pool = remoteCandidates.length > 0 ? remoteCandidates : [
      { name: 'src', path: 'src', type: 'folder' },
      { name: 'package.json', path: 'package.json', type: 'file' },
      { name: 'README.md', path: 'README.md', type: 'file' },
      { name: 'tsconfig.json', path: 'tsconfig.json', type: 'file' },
    ];
    if (!query) return pool.slice(0, 10);
    const q = query.toLowerCase();
    return pool
      .filter((c) => c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q))
      .slice(0, 10);
  }, [query, remoteCandidates]);

  if (!visible || (filtered.length === 0 && !loading)) return null;

  return (
    <div className={styles.slashDropdownMenu} role="listbox" aria-label="File references">
      <div className={styles.slashDropdownHeader}>
        <span>
          文件引用 @ {loading ? <LoadingOutlined style={{ marginLeft: 4 }} /> : `(${filtered.length})`}
        </span>
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
                onSelect(item as FileReferenceCandidate);
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
        })}
      </div>
    </div>
  );
});

export default FileReferencePopover;
