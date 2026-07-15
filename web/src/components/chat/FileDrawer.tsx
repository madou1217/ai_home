import { memo, useEffect, useState } from 'react';
import { Drawer, Tabs, Grid } from 'antd';
import { fsAPI } from '@/services/api';
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

const FileDrawer = ({ open, tabs, activeKey, onClose, onChangeTab }: Props) => {
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [contentMap, setContentMap] = useState<Record<string, string>>({});
  const [errorMap, setErrorMap] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    tabs.forEach((tab) => {
      const tabKey = getFileTabKey(tab.path, tab.source);
      if (getFilePreviewKind(tab.path) === 'image') return;
      if (contentMap[tabKey] || errorMap[tabKey] || loadingMap[tabKey]) return;

      setLoadingMap((prev) => ({ ...prev, [tabKey]: true }));
      fsAPI.read(tab.path, tab.projectPath, tab.source).then((res) => {
        setContentMap((prev) => ({ ...prev, [tabKey]: res.content }));
      }).catch((err) => {
        const msg = err.response?.data?.message || err.message || '加载失败';
        setErrorMap((prev) => ({ ...prev, [tabKey]: msg }));
      }).finally(() => {
        setLoadingMap((prev) => ({ ...prev, [tabKey]: false }));
      });
    });
  }, [open, tabs, contentMap, errorMap, loadingMap]);

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
          const loading = loadingMap[tabKey];
          const error = errorMap[tabKey];
          const content = contentMap[tabKey];
          const mediaUrl = getFilePreviewKind(tab.path) === 'image'
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
                content={content}
                mediaUrl={mediaUrl}
                loading={loading}
                error={error}
                projectPath={tab.projectPath}
                source={tab.source}
              />
            )
          };
        })}
      />
    </Drawer>
  );
};

export default memo(FileDrawer);
