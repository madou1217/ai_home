import { Breadcrumb, Modal } from 'antd';
import { FolderOpenOutlined, LoadingOutlined, RightOutlined } from '@ant-design/icons';
import { useSurfaceSwitch } from '@/hooks/use-surface-switch';
import { buildRemotePathCrumbs } from './ssh-hosts-model';
import type { useSshDirectoryBrowser } from './use-ssh-hosts';

export interface SshDirectoryBrowserModalProps {
  dirBrowser: ReturnType<typeof useSshDirectoryBrowser>;
  onConfirm: () => void;
}

/**
 * 远程 SSH 目录浏览器弹窗：拆离自 SshHostsPanel.tsx。
 */
export default function SshDirectoryBrowserModal({
  dirBrowser,
  onConfirm
}: SshDirectoryBrowserModalProps) {
  const { surfaceRef: dirListSurfaceRef, switchSurface: switchDirSurface } = useSurfaceSwitch<HTMLDivElement>();

  const renderBreadcrumbs = () => {
    if (!dirBrowser.currentPath) return null;
    const crumbs = buildRemotePathCrumbs(dirBrowser.currentPath);
    const items = [
      {
        key: 'root',
        title: (
          <span
            className="ssh-dir-crumb"
            onClick={() => switchDirSurface(() => dirBrowser.navigate('/'), { direction: 'backward' })}
          >
            [Root]
          </span>
        )
      },
      ...crumbs.map((crumb) => ({
        key: crumb.path,
        title: (
          <span
            className={crumb.last ? 'ssh-dir-crumb ssh-dir-crumb--current' : 'ssh-dir-crumb'}
            onClick={crumb.last ? undefined : () => switchDirSurface(() => dirBrowser.navigate(crumb.path), { direction: 'backward' })}
          >
            {crumb.name}
          </span>
        )
      }))
    ];

    return (
      <Breadcrumb
        separator={<RightOutlined className="ssh-dir-crumb-sep" />}
        className="ssh-dir-breadcrumb"
        items={items}
      />
    );
  };

  return (
    <Modal
      title="选择远端工作目录"
      open={dirBrowser.open}
      onOk={onConfirm}
      onCancel={dirBrowser.close}
      okText="确认路径"
      cancelText="取消"
      width={680}
    >
      <div className="ssh-form-body">
        {renderBreadcrumbs()}

        <div ref={dirListSurfaceRef} className="directory-list-container ssh-dir-list">
          {dirBrowser.loading ? (
            <div className="ssh-dir-loading">
              <LoadingOutlined className="ssh-dir-loading-icon" />
              <span className="hud-label">正在读取远程目录…</span>
            </div>
          ) : (
            <div className="ssh-dir-rows">
              {dirBrowser.parentPath && dirBrowser.currentPath !== '/' ? (
                <div
                  className="dir-item ssh-dir-item ssh-dir-item--parent"
                  onDoubleClick={() => switchDirSurface(() => dirBrowser.navigate(dirBrowser.parentPath), { direction: 'backward' })}
                >
                  <FolderOpenOutlined className="ssh-dir-item-icon" />
                  <strong className="ssh-dir-item-up">.. (返回上级目录)</strong>
                </div>
              ) : null}

              {dirBrowser.dirs.length === 0 ? (
                <div className="ssh-dir-empty hud-label">
                  当前目录无子目录，可双击上级目录返回。
                </div>
              ) : (
                dirBrowser.dirs.map((dir) => {
                  const isSelected = dirBrowser.selectedPath === dir.path;
                  return (
                    <div
                      key={dir.path}
                      className={`dir-item ssh-dir-item${isSelected ? ' ssh-dir-item--selected' : ''}`}
                      onClick={() => dirBrowser.select(dir.path)}
                      onDoubleClick={() => switchDirSurface(() => dirBrowser.navigate(dir.path), { direction: 'forward' })}
                    >
                      <FolderOpenOutlined className="ssh-dir-item-icon" />
                      <span>{dir.name}</span>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        <div className="ssh-dir-selected">
          <span className="ssh-dir-selected-label hud-label">当前选定：</span>
          <code className="ssh-dir-selected-path">{dirBrowser.selectedPath || '未选择'}</code>
        </div>
      </div>
    </Modal>
  );
}
