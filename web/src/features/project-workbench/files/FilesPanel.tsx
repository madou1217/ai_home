import { useCallback, useEffect, useRef, useState } from 'react';
import { Spin, Tree, Empty } from 'antd';
import type { TreeDataNode } from 'antd';
import { FolderOutlined, FolderOpenOutlined, LeftOutlined, ReloadOutlined } from '@ant-design/icons';
import FilePreviewPane from '@/components/chat/FilePreviewPane';
import FileTypeIcon from '@/components/chat/FileTypeIcon';
import { buildFileMediaUrl, getFilePreviewKind } from '@/components/chat/file-preview-utils';
import { fsAPI, parseFileRequestError } from '@/services/api';
import type { FileRequestError, FileTreeEntry } from '@/services/api';
import Button from '@/components/ui/AppButton';
import styles from '../project-workbench.module.css';

interface Props {
  projectPath: string;
  mobile?: boolean;
  // 三栏宿主把「刷新」动作上移到栏工具行：注册回调后即隐藏面板内标题栏，避免双重标题。
  registerRefresh?: (refresh: () => void) => void;
}

interface FilePreviewState {
  path: string;
  loading: boolean;
  content?: string;
  error?: FileRequestError;
}

function entryToTreeNode(entry: FileTreeEntry, parentPath: string): TreeDataNode {
  const key = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  return {
    key,
    title: entry.name,
    isLeaf: entry.type === 'file',
    // 文件按类型出 FileTypeIcon（与 chat 文件预览一致）；目录不留节点级图标，
    // 交给 Tree 级 icon 函数按展开态切换（rc-tree 规则：节点 icon 优先于 Tree icon）。
    icon: entry.type === 'directory' ? undefined : <FileTypeIcon filePath={entry.name} size="small" />,
  };
}

export default function FilesPanel({ projectPath, mobile, registerRefresh }: Props) {
  const [treeData, setTreeData] = useState<TreeDataNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<FilePreviewState | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const requestSeq = useRef(0);

  const loadDir = useCallback(async (dirPath: string): Promise<TreeDataNode[]> => {
    const result = await fsAPI.tree(projectPath, dirPath);
    return result.entries.map((entry) => entryToTreeNode(entry, dirPath));
  }, [projectPath]);

  const loadRoot = useCallback(async () => {
    setLoading(true);
    try {
      const nodes = await loadDir('');
      setTreeData(nodes);
    } catch { setTreeData([]); }
    setLoading(false);
  }, [loadDir]);

  useEffect(() => { void loadRoot(); }, [loadRoot]);

  // 向栏工具行注册刷新动作（仅三栏宿主传入）。
  useEffect(() => {
    registerRefresh?.(() => { void loadRoot(); });
  }, [registerRefresh, loadRoot]);

  const onLoadData = useCallback(async (node: TreeDataNode) => {
    if (node.children?.length) return;
    const children = await loadDir(String(node.key));
    setTreeData((prev) => updateTreeChildren(prev, String(node.key), children));
  }, [loadDir]);

  const onSelect = useCallback(async (_: unknown, info: { node: TreeDataNode }) => {
    const node = info.node;
    if (!node.isLeaf) return;
    const filePath = String(node.key);
    const absolutePath = `${projectPath}/${filePath}`;
    setSelectedKeys([filePath]);
    const seq = ++requestSeq.current;
    setPreview({ path: absolutePath, loading: true });
    try {
      if (getFilePreviewKind(filePath) === 'image') {
        await fsAPI.checkAccess(absolutePath, projectPath);
        if (requestSeq.current !== seq) return;
        setPreview({ path: absolutePath, loading: false });
        return;
      }
      const result = await fsAPI.read(absolutePath, projectPath);
      if (requestSeq.current !== seq) return;
      setPreview({ path: absolutePath, loading: false, content: result.content });
    } catch (error) {
      if (requestSeq.current !== seq) return;
      setPreview({ path: absolutePath, loading: false, error: parseFileRequestError(error) });
    }
  }, [projectPath]);

  if (mobile && preview) {
    return (
      <div className={styles.filesMobilePreview}>
        <div className={styles.filesMobilePreviewHeader}>
          <Button size="small" onClick={() => setPreview(null)}>返回</Button>
          <span className={styles.filesMobilePreviewTitle}>{preview.path.split('/').pop()}</span>
        </div>
        <FilePreviewPane
          path={preview.path}
          content={preview.content}
          mediaUrl={getFilePreviewKind(preview.path) === 'image' ? buildFileMediaUrl(preview.path, projectPath) : undefined}
          loading={preview.loading}
          error={preview.error}
          projectPath={projectPath}
        />
      </div>
    );
  }

  return (
    <div className={styles.filesPanel}>
      <div className={styles.filesTree}>
        {/* 标签页/移动端宿主没有栏工具行，保留面板内标题栏作为刷新入口。 */}
        {!registerRefresh ? (
          <div className={styles.filesTreeHeader}>
            <strong>文件</strong>
            <Button type="text" size="small" icon={<ReloadOutlined />} onClick={loadRoot} />
          </div>
        ) : null}
        {loading ? (
          <div className={styles.filesCentered}><Spin size="small" /></div>
        ) : treeData.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="空项目" />
        ) : (
          // icon 函数仅目录会走（文件节点自带 FileTypeIcon，节点级 icon 优先），按展开态切换文件夹图标。
          <Tree.DirectoryTree
            treeData={treeData}
            loadData={onLoadData}
            selectedKeys={selectedKeys}
            onSelect={onSelect}
            icon={(props: { expanded?: boolean; isLeaf?: boolean }) =>
              props.expanded ? <FolderOpenOutlined /> : <FolderOutlined />
            }
            showLine={false}
            blockNode
            className={styles.filesTreeBody}
          />
        )}
      </div>
      {/* 预览全栏覆盖在树之上（树保持挂载，展开态不丢），返回即回树。 */}
      {preview ? (
        <div className={styles.filesPreviewOverlay}>
          <div className={styles.filesPreviewBar}>
            <Button type="text" size="small" icon={<LeftOutlined />} onClick={() => setPreview(null)}>
              返回文件树
            </Button>
            <span className={styles.filesPreviewName} title={preview.path}>
              {preview.path.split('/').pop()}
            </span>
          </div>
          <FilePreviewPane
            path={preview.path}
            content={preview.content}
            mediaUrl={getFilePreviewKind(preview.path) === 'image' ? buildFileMediaUrl(preview.path, projectPath) : undefined}
            loading={preview.loading}
            error={preview.error}
            projectPath={projectPath}
          />
        </div>
      ) : null}
    </div>
  );
}

function updateTreeChildren(nodes: TreeDataNode[], parentKey: string, children: TreeDataNode[]): TreeDataNode[] {
  return nodes.map((node) => {
    if (String(node.key) === parentKey) return { ...node, children };
    if (node.children) return { ...node, children: updateTreeChildren(node.children, parentKey, children) };
    return node;
  });
}
