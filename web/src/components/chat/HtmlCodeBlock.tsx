import React, { useState, useMemo } from 'react';
import { EyeOutlined, CodeOutlined, DesktopOutlined, MobileOutlined } from '@ant-design/icons';
import { normalizeHtmlPreviewDocument } from './file-preview-utils';
import { openHtmlPreviewWindow } from './html-preview-window';
import styles from './chat.module.css';

const HTML_PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-downloads';

interface Props {
  code: string;
  language?: string;
}

export default function HtmlCodeBlock({ code, language = 'html' }: Props) {
  const [viewMode, setViewMode] = useState<'code' | 'preview'>('preview');
  const [copied, setCopied] = useState(false);

  const previewDoc = useMemo(() => normalizeHtmlPreviewDocument(code), [code]);

  const handleCopy = () => {
    if (copied) return;
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const handleOpenWindow = (device: 'desktop' | 'mobile') => {
    openHtmlPreviewWindow(previewDoc, { device, title: 'HTML 页面预览' });
  };

  return (
    <div className={styles.htmlBlockContainer}>
      <div className={styles.htmlBlockHeader}>
        <div className={styles.htmlBlockTabs}>
          <button
            type="button"
            className={`${styles.htmlBlockTab} ${viewMode === 'preview' ? styles.htmlBlockTabActive : ''}`}
            onClick={() => setViewMode('preview')}
          >
            <EyeOutlined /> 预览
          </button>
          <button
            type="button"
            className={`${styles.htmlBlockTab} ${viewMode === 'code' ? styles.htmlBlockTabActive : ''}`}
            onClick={() => setViewMode('code')}
          >
            <CodeOutlined /> 代码
          </button>
        </div>

        <div className={styles.htmlBlockActions}>
          {viewMode === 'preview' && (
            <>
              <button
                type="button"
                className={styles.htmlBlockActionBtn}
                title="在 PC 窗口中预览"
                onClick={() => handleOpenWindow('desktop')}
              >
                <DesktopOutlined /> PC 弹窗
              </button>
              <button
                type="button"
                className={styles.htmlBlockActionBtn}
                title="在手机窗口中预览"
                onClick={() => handleOpenWindow('mobile')}
              >
                <MobileOutlined /> 手机弹窗
              </button>
            </>
          )}
          <button
            type="button"
            className={styles.htmlBlockActionBtn}
            onClick={handleCopy}
          >
            {copied ? '已复制' : '复制代码'}
          </button>
        </div>
      </div>

      <div className={styles.htmlBlockBody}>
        {viewMode === 'preview' ? (
          <div className={styles.htmlPreviewStage}>
            <iframe
              className={styles.htmlPreviewFrame}
              title="HTML Preview"
              sandbox={HTML_PREVIEW_SANDBOX}
              srcDoc={previewDoc}
            />
          </div>
        ) : (
          <pre className={styles.htmlCodeContent}>
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
