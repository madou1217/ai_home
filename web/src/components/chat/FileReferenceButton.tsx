import type { ReactNode } from 'react';
import FileTypeIcon from './FileTypeIcon';
import { basenameLike } from './file-reference-utils';
import styles from './chat.module.css';

interface Props {
  path: string;
  label?: ReactNode;
  verb?: string;
  variant?: 'inline' | 'tool';
  className?: string;
  onOpenFile: (path: string) => void;
}

function getTitle(label: ReactNode, path: string) {
  if (typeof label === 'string' && label.trim()) return label;
  return basenameLike(path);
}

export default function FileReferenceButton({
  path,
  label,
  verb,
  variant = 'inline',
  className = '',
  onOpenFile
}: Props) {
  const title = getTitle(label, path);

  return (
    <button
      type="button"
      className={[
        styles.fileReferenceButton,
        variant === 'tool' ? styles.fileReferenceButtonTool : styles.fileReferenceButtonInline,
        className
      ].filter(Boolean).join(' ')}
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onOpenFile(path);
      }}
    >
      <FileTypeIcon filePath={path} size="small" className={styles.fileReferenceIcon} />
      {verb ? <span className={styles.fileReferenceVerb}>{verb}</span> : null}
      <span className={styles.fileReferenceLabel}>{label || basenameLike(path)}</span>
    </button>
  );
}
