import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Drawer, Tabs, Grid } from 'antd';
import {
  fsAPI,
  parseFileRequestError,
  type FileRequestError,
  type FileTrustScope
} from '@/services/api';
import FilePreviewPane from './FilePreviewPane';
import FileTypeIcon from './FileTypeIcon';
import { getFileTabKey } from './file-reference-utils';
import { buildFileMediaUrl, getFilePreviewKind } from './file-preview-utils';
import styles from './chat.module.css';

export interface FileDrawerTab {
  path: string;
  title: string;
  projectPath?: string;
  source?: string;
}

interface Props {
  open: boolean;
  tabs: FileDrawerTab[];
  activeKey?: string;
  onClose: () => void;
  onChangeTab: (key: string) => void;
}

interface FilePreviewState {
  status: 'loading' | 'ready' | 'error';
  content?: string;
  resolvedPath?: string;
  error?: FileRequestError;
  trusting?: boolean;
  trustError?: string;
}

const FileDrawer = ({ open, tabs, activeKey, onClose, onChangeTab }: Props) => {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [previewState, setPreviewState] = useState<Record<string, FilePreviewState>>({});
  const requestSequence = useRef(0);
  const activeRequests = useRef<Record<string, number>>({});

  const loadPreview = useCallback(async (tab: FileDrawerTab) => {
    const tabKey = getFileTabKey(tab.path, tab.source);
    const requestId = ++requestSequence.current;
    activeRequests.current[tabKey] = requestId;
    const updatePreview = (state: FilePreviewState) => {
      if (activeRequests.current[tabKey] !== requestId) return;
      setPreviewState((current) => ({ ...current, [tabKey]: state }));
    };

    setPreviewState((current) => ({ ...current, [tabKey]: { status: 'loading' } }));
    try {
      if (getFilePreviewKind(tab.path) === 'image') {
        const metadata = await fsAPI.checkAccess(tab.path, tab.projectPath, tab.source);
        updatePreview({ status: 'ready', resolvedPath: metadata.path });
        return;
      }
      const result = await fsAPI.read(tab.path, tab.projectPath, tab.source);
      updatePreview({
        status: 'ready',
        content: result.content,
        resolvedPath: result.path
      });
    } catch (error) {
      updatePreview({ status: 'error', error: parseFileRequestError(error) });
    }
  }, []);

  useEffect(() => {
    if (open) return;
    // 文件内容可能在抽屉关闭期间变化；清空快照并使未完成请求失效，下次打开强制读取磁盘。
    activeRequests.current = {};
    setPreviewState({});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    tabs.forEach((tab) => {
      const tabKey = getFileTabKey(tab.path, tab.source);
      if (previewState[tabKey]) return;
      void loadPreview(tab);
    });
  }, [loadPreview, open, previewState, tabs]);

  const trustAndReload = useCallback(async (tab: FileDrawerTab, scope: FileTrustScope) => {
    const tabKey = getFileTabKey(tab.path, tab.source);
    setPreviewState((current) => ({
      ...current,
      [tabKey]: {
        ...current[tabKey],
        status: 'error',
        trusting: true,
        trustError: ''
      }
    }));
    try {
      await fsAPI.trust(tab.path, scope, tab.source);
      await loadPreview(tab);
    } catch (error) {
      const requestError = parseFileRequestError(error);
      setPreviewState((current) => ({
        ...current,
        [tabKey]: {
          ...current[tabKey],
          status: 'error',
          trusting: false,
          trustError: requestError.message
        }
      }));
    }
  }, [loadPreview]);

  return (
    <Drawer
      // 手机:底部大 sheet(圆角顶 + 抓手),竖向留足代码空间、贴原生;桌面:右侧 700 抽屉。
      title={isMobile ? <div className={styles.fileDrawerGrabber} aria-hidden /> : '文件预览'}
      placement={isMobile ? 'bottom' : 'right'}
      width={isMobile ? '100%' : 700}
      height={isMobile ? '90%' : undefined}
      closable={!isMobile}
      className={isMobile ? styles.fileDrawerMobile : undefined}
      onClose={onClose}
      open={open}
      styles={{ body: { padding: 0 } }}
    >
      <Tabs
        className={`${styles.fileDrawerTabs}${isMobile ? ` ${styles.fileDrawerTabsMobile}` : ''}`}
        activeKey={activeKey}
        onChange={onChangeTab}
        tabBarGutter={isMobile ? 6 : undefined}
        items={tabs.map((tab) => {
          const tabKey = getFileTabKey(tab.path, tab.source);
          const state = previewState[tabKey];
          const mediaUrl = getFilePreviewKind(tab.path) === 'image' && state?.status === 'ready'
            ? buildFileMediaUrl(tab.path, tab.projectPath, tab.source)
            : undefined;

          return {
            label: (
              <span className={styles.fileDrawerTabLabel} title={tab.title}>
                <FileTypeIcon filePath={tab.path} size="small" />
                <span className={styles.fileDrawerTabText}>{tab.title}</span>
              </span>
            ),
            key: tabKey,
            children: (
              <FilePreviewPane
                path={tab.path}
                mdPath={state?.resolvedPath}
                content={state?.content}
                mediaUrl={mediaUrl}
                loading={!state || state.status === 'loading'}
                error={state?.error}
                trusting={state?.trusting}
                trustError={state?.trustError}
                projectPath={tab.projectPath}
                source={tab.source}
                onReload={() => void loadPreview(tab)}
                onTrust={(scope) => void trustAndReload(tab, scope)}
              />
            )
          };
        })}
      />
    </Drawer>
  );
};

export default memo(FileDrawer);
