import { Breadcrumb, Modal } from 'antd';
import { FolderOpenOutlined, LoadingOutlined, RightOutlined } from '@ant-design/icons';
import { buildDirectoryBreadcrumbs } from './directory-path-policy';
import styles from './directory-picker.module.css';

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
        className={item.current ? styles.crumbCurrent : styles.crumbLink}
        onClick={item.current ? undefined : () => onNavigate(item.path)}
      >
        {item.label}
      </span>
    ),
  }));
  return items.length ? (
    <Breadcrumb
      items={items}
      separator={<RightOutlined className={styles.crumbSeparator} />}
      className={styles.breadcrumb}
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
      className={`dir-item ${styles.row}${selected ? ` ${styles.rowSelected}` : ''}`}
      onClick={() => onSelect(directory.path)}
      onDoubleClick={() => onNavigate(directory.path)}
    >
      <FolderOpenOutlined className={styles.rowIcon} />
      <span>{directory.name}</span>
    </div>
  );
}

function DirectoryList(props: DirectoryPickerDialogProps) {
  if (props.loading) {
    return (
      <div className={styles.loading}>
        <LoadingOutlined className={styles.loadingIcon} />
        <span>正在获取服务端目录列表，请稍后...</span>
      </div>
    );
  }
  return (
    <div className={styles.listInner}>
      {props.parentPath && props.currentPath !== props.parentPath ? (
        <DirectoryRow
          directory={{ name: '.. (返回上级目录)', path: props.parentPath }}
          selected={false}
          onNavigate={props.onNavigate}
          onSelect={props.onSelect}
        />
      ) : null}
      {props.directories.length === 0 ? (
        <div className={styles.empty}>
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
      <div className={styles.body}>
        <DirectoryPath currentPath={props.currentPath} onNavigate={props.onNavigate} />
        <div
          className={`directory-list-container hud-panel hud-panel--sm ${styles.listPanel}`}
        >
          <DirectoryList {...props} />
        </div>
        <div className={styles.selection}>
          <span className="hud-label">当前选定路径:</span>
          <code className={styles.selectionPath}>
            {props.selectedPath || '未选择'}
          </code>
        </div>
      </div>
    </Modal>
  );
}
