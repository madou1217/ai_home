import { memo, useEffect, useState } from 'react';
import { Drawer, Spin, Tabs } from 'antd';
import { fsAPI } from '@/services/api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';
import styles from './chat.module.css';

export interface FileDrawerTab {
  path: string;
  title: string;
  projectPath?: string;
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
      if (contentMap[tab.path] || errorMap[tab.path] || loadingMap[tab.path]) return;

      setLoadingMap((prev) => ({ ...prev, [tab.path]: true }));
      fsAPI.read(tab.path, tab.projectPath).then((res) => {
        setContentMap((prev) => ({ ...prev, [tab.path]: res.content }));
      }).catch((err) => {
        const msg = err.response?.data?.message || err.message || '加载失败';
        setErrorMap((prev) => ({ ...prev, [tab.path]: msg }));
      }).finally(() => {
        setLoadingMap((prev) => ({ ...prev, [tab.path]: false }));
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
        activeKey={activeKey}
        onChange={onChangeTab}
        items={tabs.map((tab) => {
          const loading = loadingMap[tab.path];
          const error = errorMap[tab.path];
          const content = contentMap[tab.path];

          let ext = tab.path.split('.').pop()?.toLowerCase() || 'txt';
          if (ext === 'tsx' || ext === 'jsx') ext = 'tsx';

          return {
            label: tab.title,
            key: tab.path,
            children: (
              <div style={{ height: 'calc(100vh - 120px)', overflow: 'auto', padding: 24 }}>
                {loading && <div style={{ textAlign: 'center', marginTop: 40 }}><Spin /></div>}
                {error && <div style={{ color: 'red', marginTop: 20 }}>{error}</div>}
                {content && (
                  <div className={styles.fileDrawerContent}>
                     <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        rehypePlugins={[rehypeHighlight]}
                        components={{
                          code({node, inline, className, children, ...props}: any) {
                            return !inline ? (
                              <code className={`hljs language-${ext}`} {...props}>
                                {children}
                              </code>
                            ) : (
                              <code className={className} {...props}>
                                {children}
                              </code>
                            )
                          }
                        }}
                     >
                       {`\`\`\`${ext}\n${content}\n\`\`\``}
                     </ReactMarkdown>
                  </div>
                )}
              </div>
            )
          };
        })}
      />
    </Drawer>
  );
};

export default memo(FileDrawer);
