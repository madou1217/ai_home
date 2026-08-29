import { memo, useState, useCallback, useMemo } from 'react';
import { CopyOutlined, CheckOutlined } from '@ant-design/icons';
import { message } from 'antd';
import styles from './chat.module.css';

interface Props {
  code: string;
  language?: string;
  className?: string;
}

export const CodeBlock = memo(function CodeBlock({
  code,
  language = '',
  className = '',
}: Props) {
  const [copied, setCopied] = useState(false);
  const cleanCode = useMemo(() => String(code || '').trimEnd(), [code]);

  const onCopy = useCallback(() => {
    if (copied || !cleanCode) return;
    navigator.clipboard.writeText(cleanCode).then(() => {
      setCopied(true);
      message.success('代码已复制', 1);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }, [cleanCode, copied]);

  const displayLang = useMemo(() => {
    const raw = String(language || '').toLowerCase().trim();
    if (!raw) return 'text';
    return raw;
  }, [language]);

  return (
    <div className={`${styles.codeBlockWrapper} ${className}`}>
      <div className={styles.codeBlockHeader}>
        <span className={styles.codeBlockLanguage}>{displayLang}</span>
        <button
          type="button"
          className={styles.codeBlockCopyBtn}
          onClick={onCopy}
          aria-label="复制代码"
          title="复制代码"
        >
          {copied ? (
            <>
              <CheckOutlined style={{ color: '#52c41a', marginRight: 4 }} />
              <span>已复制</span>
            </>
          ) : (
            <>
              <CopyOutlined style={{ marginRight: 4 }} />
              <span>复制</span>
            </>
          )}
        </button>
      </div>
      <pre className={styles.codeBlockContent}>
        <code>{cleanCode}</code>
      </pre>
    </div>
  );
});

export default CodeBlock;
