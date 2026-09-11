import { CloseOutlined, FileTextOutlined } from '@ant-design/icons';
import type { PendingComposerAttachment } from './use-composer-attachments';
import styles from './session-runtime.module.css';

interface Props {
  readonly attachments: readonly PendingComposerAttachment[];
  readonly onRemove: (key: string) => void;
}

export default function ComposerAttachmentPreview({ attachments, onRemove }: Props) {
  if (attachments.length === 0) return null;
  return (
    <div className={styles.composerAttachments} aria-label="待发送附件">
      {attachments.map((attachment) => (
        <div key={attachment.key} className={styles.composerAttachment} title={attachment.name}>
          {attachment.mimeType.startsWith('image/') ? <img src={attachment.dataUrl} alt={attachment.name} />
            : attachment.mimeType.startsWith('video/') ? (
              <video src={attachment.dataUrl} muted preload="metadata" aria-label={attachment.name} />
            ) : (
            <span style={{ display: 'flex', flexDirection: 'column', maxWidth: '100%', overflow: 'hidden', fontSize: 11 }}>
              <FileTextOutlined /><span title={attachment.name}>{attachment.name}</span>
            </span>
          )}
          <button
            type="button"
            aria-label={`移除 ${attachment.name}`}
            onClick={() => onRemove(attachment.key)}
          >
            <CloseOutlined />
          </button>
        </div>
      ))}
    </div>
  );
}
