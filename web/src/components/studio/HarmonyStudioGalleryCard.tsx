import { memo } from 'react';
import { Button, Space, Tag, Tooltip } from 'antd';
import {
  PictureOutlined,
  DownloadOutlined,
  EyeOutlined,
  ShareAltOutlined,
  ThunderboltFilled,
  DeleteOutlined,
} from '@ant-design/icons';
import styles from './HarmonyStudioGalleryCard.module.css';

export interface HarmonyStudioGalleryCardProps {
  id: string;
  title: string;
  prompt: string;
  imageUrl: string;
  model?: string;
  createdAt?: string;
  aspectRatio?: string;
  onPreview?: () => void;
  onDownload?: () => void;
  onShare?: () => void;
  onDelete?: () => void;
}

/**
 * HarmonyOS 6 风格灵感工坊画廊卡片 (ArkUI Studio Gallery Card)
 * 采用 24px Squircle 超级圆角、通透亚克力毛玻璃、画廊微光悬浮与流光操作胶囊
 */
export const HarmonyStudioGalleryCard = memo(function HarmonyStudioGalleryCard({
  title,
  prompt,
  imageUrl,
  model,
  createdAt,
  aspectRatio = '1:1',
  onPreview,
  onDownload,
  onShare,
  onDelete,
}: HarmonyStudioGalleryCardProps) {
  return (
    <div className={styles.galleryCard}>
      <div className={styles.imageContainer} onClick={onPreview}>
        <img src={imageUrl} alt={title || prompt} className={styles.imagePreview} loading="lazy" />
        <div className={styles.imageOverlay}>
          <Button
            type="primary"
            shape="circle"
            icon={<EyeOutlined />}
            size="middle"
            className={styles.previewBtn}
            onClick={(e) => {
              e.stopPropagation();
              onPreview && onPreview();
            }}
          />
        </div>
        <div className={styles.aspectBadge}>
          <Tag className={styles.ratioTag}>{aspectRatio}</Tag>
        </div>
      </div>

      <div className={styles.cardContent}>
        <div className={styles.titleLine}>
          <strong className={styles.titleText}>{title || '创作图像'}</strong>
          {model && <Tag className={styles.modelTag}>{model}</Tag>}
        </div>
        <p className={styles.promptText} title={prompt}>{prompt}</p>

        <div className={styles.cardFooter}>
          <span className={styles.timestamp}>{createdAt || '刚刚'}</span>
          <Space size={6}>
            {onDownload && (
              <Tooltip title="下载高清原图">
                <Button
                  type="text"
                  shape="circle"
                  size="small"
                  icon={<DownloadOutlined />}
                  onClick={onDownload}
                />
              </Tooltip>
            )}
            {onShare && (
              <Tooltip title="分享画廊长图">
                <Button
                  type="text"
                  shape="circle"
                  size="small"
                  icon={<ShareAltOutlined />}
                  onClick={onShare}
                />
              </Tooltip>
            )}
            {onDelete && (
              <Tooltip title="删除记录">
                <Button
                  type="text"
                  shape="circle"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={onDelete}
                />
              </Tooltip>
            )}
          </Space>
        </div>
      </div>
    </div>
  );
});

export default HarmonyStudioGalleryCard;
