import { useCallback, useEffect, useRef, useState } from 'react';
import { Spin, Tree, Empty } from 'antd';
import type { TreeDataNode } from 'antd';
import { FileOutlined, FolderOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import FilePreviewPane from '@/components/chat/FilePreviewPane';
import { buildFileMediaUrl, getFilePreviewKind } from '@/components/chat/file-preview-utils';
import { fsAPI, parseFileRequestError } from '@/services/api';
import type { FileRequestError, FileTreeEntry } from '@/services/api';
import Button from '@/components/ui/AppButton';
import styles from '../project-workbench.module.css';

interface Props {
  projectPath: string;
  mobile?: boolean;
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
    icon: entry.type === 'directory' ? <FolderOutlined /> : <FileOutlined />,
  };
}

export default function FilesPanel({ projectPath, mobile }: Props) {
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
        <div className={styles.filesTreeHeader}>
          <strong>文件</strong>
          <Button type="text" size="small" icon={<ReloadOutlined />} onClick={loadRoot} />
        </div>
        {loading ? (
          <div className={styles.filesCentered}><Spin size="small" /></div>
        ) : treeData.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="空项目" />
        ) : (
          <Tree.DirectoryTree
            treeData={treeData}
            loadData={onLoadData}
            selectedKeys={selectedKeys}
            onSelect={onSelect}
            icon={(props: { expanded?: boolean; isLeaf?: boolean }) =>
              props.isLeaf ? <FileOutlined /> : props.expanded ? <FolderOpenOutlined /> : <FolderOutlined />
            }
            showLine={false}
            blockNode
            className={styles.filesTreeBody}
          />
        )}
      </div>
      <div className={styles.filesPreview}>
        {preview ? (
          <FilePreviewPane
            path={preview.path}
            content={preview.content}
            loading={preview.loading}
            error={preview.error}
            projectPath={projectPath}
          />
        ) : (
          <Empty description="选择文件以预览" />
        )}
      </div>
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
