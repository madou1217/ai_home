import { memo, useMemo } from 'react';
import { CloseOutlined, FileTextOutlined } from '@ant-design/icons';
import { useFlipReorder } from '@/hooks/use-flip-reorder';
import { usePresenceList } from '@/hooks/use-presence-list';
import styles from './composer/composer.module.css';
import type { ChatDocumentAttachment } from './attachment-files';
import type { PendingChatAttachment } from './use-chat-file-input';

export interface ComposerAttachmentGalleryProps {
  images: string[];
  onRemove: (index: number) => void;
  documents?: readonly ChatDocumentAttachment[];
  onRemoveDocument?: (index: number) => void;
  onRetryDocument?: (index: number) => void;
  pending?: readonly PendingChatAttachment[];
  onRetryPending?: (key: string) => void;
  onRemovePending?: (key: string) => void;
}

type Chip =
  | { key: string; kind: 'document'; index: number; document: ChatDocumentAttachment }
  | { key: string; kind: 'pending'; index: number; pending: PendingChatAttachment }
  | { key: string; kind: 'image'; index: number; image: string };

/** 同名同内容会出现多次，用出现序号去重，保证 key 在同一批附件里唯一且稳定。 */
function withOccurrence(bases: string[]): string[] {
  const seen = new Map<string, number>();
  return bases.map((base) => {
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  });
}

/**
 * HarmonyOS 6 风格多模态附件卡片胶囊画廊
 * 支持超级曲率圆角、内高光微描边、悬浮一键移除与横向平滑滚动。
 * 移除时被删的胶囊先播一次退出动画，其余胶囊用 FLIP 滑到空出来的位置。
 */
export const ComposerAttachmentGallery = memo(function ComposerAttachmentGallery({
  images,
  onRemove,
  documents = [],
  onRemoveDocument,
  onRetryDocument,
  pending = [],
  onRetryPending,
  onRemovePending,
}: ComposerAttachmentGalleryProps) {
  const chips = useMemo<Chip[]>(() => {
    const docKeys = withOccurrence(documents.map((document) => `doc:${document.name}:${document.text.length}`));
    const pendingKeys = withOccurrence(pending.map((attachment) => `pending:${attachment.key}`));
    const imageKeys = withOccurrence(images.map((image) => `image:${image.length}:${image.slice(-64)}`));
    return [
      ...documents.map((document, index) => ({ key: docKeys[index], kind: 'document' as const, index, document })),
      ...pending.map((item, index) => ({ key: pendingKeys[index], kind: 'pending' as const, index, pending: item })),
      ...images.map((image, index) => ({ key: imageKeys[index], kind: 'image' as const, index, image }))
    ];
  }, [documents, pending, images]);
  const { render } = usePresenceList(chips, (chip) => chip.key);
  const flipRef = useFlipReorder<HTMLDivElement>(chips);

  if (render.length === 0) return null;

  const renderChip = (chip: Chip, isLeaving: boolean) => {
    const className = `${styles.attachmentGalleryCard}${isLeaving ? ' aih-leaving' : ''}`;
    if (chip.kind === 'document') {
      const document = chip.document;
      return (
        <div key={chip.key} data-flip-key={chip.key} className={`${className} ${styles.attachmentDocumentCard}`} title={document.error || document.name} data-status={document.status || 'ready'}>
          <FileTextOutlined className={styles.attachmentDocIcon} />
          <span className={styles.attachmentDocumentName} title={document.error || document.name}>
            {document.name}
            <small>{formatBytes(document.size || new TextEncoder().encode(document.text).byteLength)} · {statusLabel(document.status)}{document.error ? ` · ${document.error}` : ''}</small>
          </span>
          {document.status === 'failed' && onRetryDocument ? (
            <button type="button" className={styles.attachmentRetryBadge}
              onClick={() => onRetryDocument(chip.index)} aria-label={`重试 ${document.name}`}>
              重试
            </button>
          ) : null}
          <button type="button" className={styles.attachmentRemoveBadge}
            onClick={() => onRemoveDocument?.(chip.index)} aria-label={`移除 ${document.name}`}>
            <CloseOutlined style={{ fontSize: 9 }} />
          </button>
        </div>
      );
    }
    if (chip.kind === 'pending') {
      const attachment = chip.pending;
      return (
        <div key={chip.key} data-flip-key={chip.key} className={`${className} ${styles.attachmentDocumentCard}`} title={attachment.error || attachment.name} data-status={attachment.status}>
          <FileTextOutlined className={styles.attachmentDocIcon} />
          <span className={styles.attachmentDocumentName} title={attachment.error || attachment.name}>
            {attachment.name}
            <small>{formatBytes(attachment.size)} · {attachment.status === 'preparing' ? '准备中' : '失败'}{attachment.error ? ` · ${attachment.error}` : ''}</small>
          </span>
          {attachment.status === 'failed' && onRetryPending ? (
            <button type="button" className={styles.attachmentRetryBadge}
              onClick={() => onRetryPending(attachment.key)} aria-label={`重试 ${attachment.name}`}>
              重试
            </button>
          ) : null}
          <button type="button" className={styles.attachmentRemoveBadge}
            onClick={() => onRemovePending?.(attachment.key)} aria-label={`移除 ${attachment.name}`}>
            <CloseOutlined style={{ fontSize: 9 }} />
          </button>
        </div>
      );
    }
    const image = chip.image;
    return (
      <div key={chip.key} data-flip-key={chip.key} className={className}>
        <div className={styles.attachmentThumbWrap}>
          {image.startsWith('data:video/') ? (
            <video src={image} muted preload="metadata" aria-label="视频附件" className={styles.attachmentThumbImg} />
          ) : image.startsWith('data:image/') || image.startsWith('http') ? (
            <img src={image} alt="附件预览" className={styles.attachmentThumbImg} />
          ) : (
            <FileTextOutlined className={styles.attachmentDocIcon} />
          )}
        </div>
        <button
          type="button"
          className={styles.attachmentRemoveBadge}
          onClick={() => onRemove(chip.index)}
          title="移除此附件"
          aria-label="移除附件"
        >
          <CloseOutlined style={{ fontSize: 9 }} />
        </button>
      </div>
    );
  };

  return (
    <div ref={flipRef} className={styles.attachmentGalleryRow} aria-label="待发送附件">
      {render.map((entry) => renderChip(entry.item, entry.leaving))}
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
