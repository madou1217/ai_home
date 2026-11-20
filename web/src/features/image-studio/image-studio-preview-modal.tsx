import { DownloadOutlined } from '@ant-design/icons';
import { Button, Modal } from 'antd';
import type { ImageStudioAsset, ImageStudioRevision } from '@/types';
import { formatAssetSize } from './image-studio-utils';
import styles from './image-studio-preview-modal.module.css';

export interface ImageStudioPreviewItem {
  revision: ImageStudioRevision;
  asset: ImageStudioAsset;
  frameLabel: string;
  imageUrl: string;
}

interface ImageStudioPreviewModalProps {
  preview: ImageStudioPreviewItem | null;
  onClose: () => void;
  onDownload?: (revision: ImageStudioRevision, asset: ImageStudioAsset) => void;
}

export function ImageStudioPreviewModal({
  preview,
  onClose,
  onDownload,
}: ImageStudioPreviewModalProps) {
  return (
    <Modal
      open={Boolean(preview)}
      title={preview ? `${preview.frameLabel} · ${preview.revision.model}` : '全图预览'}
      onCancel={onClose}
      footer={null}
      width="min(92vw, 1200px)"
      centered
      destroyOnClose
      keyboard
      maskClosable
      closable
    >
      {preview && (
        <div
          className={styles.previewContent}
          role="region"
          aria-label={`${preview.frameLabel} 全图预览`}
        >
          <div className={styles.previewStage}>
            <img
              className={styles.previewImage}
              src={preview.imageUrl}
              alt={preview.revision.prompt || `${preview.frameLabel} 全图预览`}
            />
          </div>
          <div className={styles.previewMeta}>
            <div className={styles.previewText}>
              <span className={styles.previewSpecs}>
                {preview.revision.provider} · {preview.revision.mode === 'edit' ? 'EDIT' : 'GENERATE'} · {formatAssetSize(preview.asset.byteLength)}
              </span>
              {preview.revision.prompt && (
                <p className={styles.previewPrompt}>{preview.revision.prompt}</p>
              )}
            </div>
            {onDownload && (
              <Button
                icon={<DownloadOutlined />}
                onClick={() => onDownload(preview.revision, preview.asset)}
              >
                下载原图
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default ImageStudioPreviewModal;
