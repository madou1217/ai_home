import { memo } from 'react';
import { CloseOutlined, FileTextOutlined } from '@ant-design/icons';
import styles from './composer/composer.module.css';
import type { ChatDocumentAttachment } from './attachment-files';

export interface ComposerAttachmentGalleryProps {
  images: string[];
  onRemove: (index: number) => void;
  documents?: readonly ChatDocumentAttachment[];
  onRemoveDocument?: (index: number) => void;
  onRetryDocument?: (index: number) => void;
}

/**
 * HarmonyOS 6 风格多模态附件卡片胶囊画廊
 * 支持超级曲率圆角、内高光微描边、悬浮一键移除与横向平滑滚动
 */
export const ComposerAttachmentGallery = memo(function ComposerAttachmentGallery({
  images,
  onRemove,
  documents = [],
  onRemoveDocument,
  onRetryDocument,
}: ComposerAttachmentGalleryProps) {
  if (images.length === 0 && documents.length === 0) return null;

  return (
    <div className={styles.attachmentGalleryRow} aria-label="待发送附件">
      {documents.map((document, index) => (
        <div key={`${document.name}-${index}`} className={`${styles.attachmentGalleryCard} ${styles.attachmentDocumentCard}`} title={document.error || document.name} data-status={document.status || 'ready'}>
          <FileTextOutlined className={styles.attachmentDocIcon} />
          <span className={styles.attachmentDocumentName} title={document.error || document.name}>
            {document.name}
            <small>{formatBytes(document.size || new TextEncoder().encode(document.text).byteLength)} · {statusLabel(document.status)}{document.error ? ` · ${document.error}` : ''}</small>
          </span>
          {document.status === 'failed' && onRetryDocument ? (
            <button type="button" className={styles.attachmentRetryBadge}
              onClick={() => onRetryDocument(index)} aria-label={`重试 ${document.name}`}>
              重试
            </button>
          ) : null}
          <button type="button" className={styles.attachmentRemoveBadge}
            onClick={() => onRemoveDocument?.(index)} aria-label={`移除 ${document.name}`}>
            <CloseOutlined style={{ fontSize: 9 }} />
          </button>
        </div>
      ))}
      {images.map((img, idx) => (
        <div key={idx} className={styles.attachmentGalleryCard}>
          <div className={styles.attachmentThumbWrap}>
            {img.startsWith('data:video/') ? (
              <video src={img} muted preload="metadata" aria-label="视频附件" className={styles.attachmentThumbImg} />
            ) : img.startsWith('data:image/') || img.startsWith('http') ? (
              <img src={img} alt="附件预览" className={styles.attachmentThumbImg} />
            ) : (
              <FileTextOutlined className={styles.attachmentDocIcon} />
            )}
          </div>
          <button
            type="button"
            className={styles.attachmentRemoveBadge}
            onClick={() => onRemove(idx)}
            title="移除此附件"
            aria-label="移除附件"
          >
            <CloseOutlined style={{ fontSize: 9 }} />
          </button>
        </div>
      ))}
    </div>
  );
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusLabel(status: ChatDocumentAttachment['status']): string {
  if (status === 'preparing') return '准备中';
  if (status === 'uploading') return '上传中';
  if (status === 'uploaded') return '已上传';
  if (status === 'failed') return '失败';
  return '就绪';
}

export default ComposerAttachmentGallery;
