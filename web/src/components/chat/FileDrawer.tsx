import { memo, useEffect, useState } from 'react';
import { Drawer, Tabs } from 'antd';
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
      title="文件预览"
      placement="right"
      width={700}
      onClose={onClose}
      open={open}
      styles={{ body: { padding: 0 } }}
    >
      <Tabs
        className={styles.fileDrawerTabs}
        activeKey={activeKey}
        onChange={onChangeTab}
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
              />
            )
          };
        })}
      />
    </Drawer>
  );
};

export default memo(FileDrawer);
