import { Button, Spin } from 'antd';
import { FolderOpenOutlined, RightOutlined, RollbackOutlined } from '@ant-design/icons';
import { buildRemotePathCrumbs } from '@/features/ssh-hosts/ssh-hosts-model';
import type { useSshDirectoryBrowser } from '@/features/ssh-hosts/use-ssh-hosts';
import { DetailSheet, EmptySignal } from '@/mobile/ui';
import styles from './fabric.module.css';

type DirectoryBrowser = ReturnType<typeof useSshDirectoryBrowser>;

/**
 * 远程工作目录浏览器（sshHostsAPI.browseSshDirectory）。
 * 触屏没有双击：点按目录即进入（进入后该目录即为选定路径），面包屑 / 「返回上级」逐级回退，
 * 页脚「确认选择该路径」把选定路径写回工作空间表单。
 */
export default function SshDirectorySheet({
  browser,
  onConfirm
}: {
  browser: DirectoryBrowser;
  onConfirm: (path: string) => void;
}) {
  const crumbs = browser.currentPath ? buildRemotePathCrumbs(browser.currentPath) : [];
  return (
    <DetailSheet
      open={browser.open}
      onClose={browser.close}
      code="BROWSE"
      title="远程工作目录浏览器"
      maxHeight="92dvh"
      footer={(
        <>
          <Button onClick={browser.close}>取消</Button>
          <Button
            type="primary"
            disabled={browser.loading}
            onClick={() => {
              const selected = browser.confirm();
              if (selected) onConfirm(selected);
            }}
          >
            确认选择该路径
          </Button>
        </>
      )}
    >
      <div className={styles.dir}>
        {browser.currentPath ? (
          <nav className={styles.dirCrumbs} aria-label="当前路径">
            <button type="button" className={styles.dirCrumb} onClick={() => browser.navigate('/')}>
              [Root]
            </button>
            {crumbs.map((crumb) => (
              <span key={crumb.path} className={styles.dirCrumbItem}>
                <RightOutlined className={styles.dirCrumbSep} aria-hidden="true" />
                <button
                  type="button"
                  className={styles.dirCrumb}
                  aria-current={crumb.last ? 'location' : undefined}
                  disabled={crumb.last}
                  onClick={() => browser.navigate(crumb.path)}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>
        ) : null}

        {browser.loading ? (
          <div className={styles.dirLoading} role="status">
            <Spin size="small" />
            <span className="hud-label">正在获取远程目录列表，请稍后...</span>
          </div>
        ) : (
          <div className={styles.dirList} role="list" aria-label="子目录">
            {browser.parentPath && browser.currentPath !== '/' ? (
              <button type="button" role="listitem" className={styles.dirRow} onClick={() => browser.navigate(browser.parentPath)}>
                <RollbackOutlined aria-hidden="true" />
                <strong>.. (返回上级目录)</strong>
              </button>
            ) : null}
            {browser.dirs.length === 0 ? (
              <EmptySignal title="EMPTY DIR" description="没有子目录。可返回上级目录，或直接确认当前路径。" />
            ) : (
              browser.dirs.map((dir) => (
                <button
                  key={dir.path}
                  type="button"
                  role="listitem"
                  className={styles.dirRow}
                  onClick={() => browser.navigate(dir.path)}
                >
                  <FolderOpenOutlined aria-hidden="true" />
                  <span>{dir.name}</span>
                  <RightOutlined className={styles.dirRowArrow} aria-hidden="true" />
                </button>
              ))
            )}
          </div>
        )}

        <div className={styles.dirSelected}>
          <span className="hud-label">当前选定路径:</span>
          <code>{browser.selectedPath || '未选择'}</code>
        </div>
      </div>
    </DetailSheet>
  );
}
