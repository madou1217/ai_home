import { CloseOutlined, FileTextOutlined } from '@ant-design/icons';
import type { PendingComposerAttachment } from './use-composer-attachments';
import { usePresenceList } from '@/hooks/use-presence-list';
import styles from './session-runtime.module.css';
import attachmentStyles from '@/components/chat/composer/composer.module.css';

interface Props {
  readonly attachments: readonly PendingComposerAttachment[];
  readonly onRemove: (key: string) => void;
  readonly onRetry: (key: string) => void;
}

export default function ComposerAttachmentPreview({ attachments, onRemove, onRetry }: Props) {
  // 移除附件先留 140ms 播退场（.aih-leaving）再卸载，和 legacy 附件画廊同一套语义。
  const presence = usePresenceList([...attachments], (attachment) => attachment.key, 170);
  if (presence.render.length === 0) return null;
  return (
    <div className={styles.composerAttachments} aria-label="待发送附件">
      {presence.render.map(({ item: attachment, leaving }) => {
        const isMedia = attachment.mimeType.startsWith('image/') || attachment.mimeType.startsWith('video/');
        return (
        <div
          key={attachment.key}
          className={`${styles.composerAttachment}${isMedia ? '' : ` ${attachmentStyles.composerDocumentAttachment}`}${leaving ? ' aih-leaving' : ''}`}
          title={attachment.error || attachment.name}
          data-status={attachment.status}
        >
          {attachment.mimeType.startsWith('image/') ? <img src={attachment.dataUrl} alt={attachment.name} />
            : attachment.mimeType.startsWith('video/') ? (
              <video src={attachment.dataUrl} muted preload="metadata" aria-label={attachment.name} />
            ) : (
            // 文档芯片：图标 + 单行文件名 + 单行大小/状态，全部在卡片内截断，不撑高附件行。
            <span className={attachmentStyles.composerDocumentChip}>
              <FileTextOutlined aria-hidden />
              <span className={attachmentStyles.composerDocumentChipText}>
                <strong>{attachment.name}</strong>
                <small>{formatBytes(attachment.size)} · {attachment.error || statusLabel(attachment.status)}</small>
              </span>
            </span>
          )}
          {isMedia ? (
            <span className={attachmentStyles.composerAttachmentMeta}>
              <strong>{attachment.name}</strong>
              <small>{formatBytes(attachment.size)} · {statusLabel(attachment.status)}{attachment.error ? ` · ${attachment.error}` : ''}</small>
            </span>
          ) : null}
          {attachment.status === 'failed' ? (
            <button type="button" className={attachmentStyles.composerAttachmentRetry} onClick={() => onRetry(attachment.key)} aria-label={`重试 ${attachment.name}`}>
              重试
            </button>
          ) : null}
          <button
            type="button"
            aria-label={`移除 ${attachment.name}`}
            onClick={() => onRemove(attachment.key)}
          >
            <CloseOutlined />
          </button>
        </div>
        );
      })}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusLabel(status: PendingComposerAttachment['status']): string {
  if (status === 'preparing') return '准备中';
  if (status === 'uploading') return '上传中';
  if (status === 'uploaded') return '已上传';
  if (status === 'failed') return '失败';
  return '就绪';
}
