import { Breadcrumb, Modal } from 'antd';
import { FolderOpenOutlined, LoadingOutlined, RightOutlined } from '@ant-design/icons';
import { buildDirectoryBreadcrumbs } from './directory-path-policy';

export type DirectoryEntry = { name: string; path: string };

type DirectoryPickerDialogProps = {
  open: boolean;
  currentPath: string;
  parentPath: string;
  directories: DirectoryEntry[];
  loading: boolean;
  selectedPath: string;
  onCancel: () => void;
  onConfirm: () => void;
  onNavigate: (path: string) => void;
  onSelect: (path: string) => void;
};

function DirectoryPath({
  currentPath,
  onNavigate,
}: Pick<DirectoryPickerDialogProps, 'currentPath' | 'onNavigate'>) {
  const items = buildDirectoryBreadcrumbs(currentPath).map((item) => ({
    key: item.key,
    title: (
      <span
        style={item.current
          ? { fontWeight: 'bold' }
          : { cursor: 'pointer', color: 'var(--color-info)' }}
        onClick={item.current ? undefined : () => onNavigate(item.path)}
      >
        {item.label}
      </span>
    ),
  }));
  return items.length ? (
    <Breadcrumb
      items={items}
      separator={<RightOutlined style={{ fontSize: 10, color: '#bfbfbf' }} />}
      style={{ marginBottom: 16, background: '#f5f5f5', padding: '8px 12px', borderRadius: 4 }}
    />
  ) : null;
}

function DirectoryRow({
  directory,
  selected,
  onNavigate,
  onSelect,
}: {
  directory: DirectoryEntry;
  selected: boolean;
  onNavigate: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <div
      className="dir-item"
      style={{
        padding: '8px 16px', cursor: 'pointer', userSelect: 'none',
        background: selected ? '#e6f7ff' : '#fff', borderBottom: '1px solid #f5f5f5',
      }}
      onClick={() => onSelect(directory.path)}
      onDoubleClick={() => onNavigate(directory.path)}
    >
      <FolderOpenOutlined style={{ marginRight: 8, color: '#faad14' }} />
      <span>{directory.name}</span>
    </div>
  );
}

function DirectoryList(props: DirectoryPickerDialogProps) {
  if (props.loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', flexDirection: 'column', gap: 12 }}>
        <LoadingOutlined style={{ fontSize: 24 }} />
        <span>正在获取服务端目录列表，请稍后...</span>
      </div>
    );
  }
  return (
    <div style={{ padding: '8px 0' }}>
      {props.parentPath && props.currentPath !== props.parentPath ? (
        <DirectoryRow
          directory={{ name: '.. (返回上级目录)', path: props.parentPath }}
          selected={false}
          onNavigate={props.onNavigate}
          onSelect={props.onSelect}
        />
      ) : null}
      {props.directories.length === 0 ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: '#bfbfbf' }}>
          没有子目录。双击上级目录可返回。
        </div>
      ) : props.directories.map((directory) => (
        <DirectoryRow
          key={directory.path}
          directory={directory}
          selected={props.selectedPath === directory.path}
          onNavigate={props.onNavigate}
          onSelect={props.onSelect}
        />
      ))}
    </div>
  );
}

export default function DirectoryPickerDialog(props: DirectoryPickerDialogProps) {
  return (
    <Modal
      title="服务端工作目录浏览器"
      open={props.open}
      onOk={props.onConfirm}
      onCancel={props.onCancel}
      okText="确认选择该路径"
      cancelText="取消"
      width={700}
      destroyOnClose
    >
      <div style={{ marginTop: 16 }}>
        <DirectoryPath currentPath={props.currentPath} onNavigate={props.onNavigate} />
        <div
          className="directory-list-container"
          style={{ border: '1px solid #d9d9d9', borderRadius: 4, height: 350, overflowY: 'auto', background: '#fff' }}
        >
          <DirectoryList {...props} />
        </div>
        <div style={{ marginTop: 16 }}>
          <span style={{ marginRight: 8, fontWeight: 'bold' }}>当前选定路径:</span>
          <code style={{ background: '#f5f5f5', padding: '4px 8px', borderRadius: 4, fontSize: 13 }}>
            {props.selectedPath || '未选择'}
          </code>
        </div>
      </div>
    </Modal>
  );
}
