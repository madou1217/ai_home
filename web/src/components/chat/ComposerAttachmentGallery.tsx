import { memo } from 'react';
import { CloseOutlined, FileTextOutlined } from '@ant-design/icons';
import styles from './chat.module.css';

export interface ComposerAttachmentGalleryProps {
  images: string[];
  onRemove: (index: number) => void;
}

/**
 * HarmonyOS 6 风格多模态附件卡片胶囊画廊
 * 支持超级曲率圆角、内高光微描边、悬浮一键移除与横向平滑滚动
 */
export const ComposerAttachmentGallery = memo(function ComposerAttachmentGallery({
  images,
  onRemove,
}: ComposerAttachmentGalleryProps) {
  if (!images || images.length === 0) return null;

  return (
    <div className={styles.attachmentGalleryRow}>
      {images.map((img, idx) => (
        <div key={idx} className={styles.attachmentGalleryCard}>
          <div className={styles.attachmentThumbWrap}>
            {img.startsWith('data:image/') || img.startsWith('http') ? (
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

export default ComposerAttachmentGallery;
