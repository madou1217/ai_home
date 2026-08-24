import React from 'react';
import {
  CheckOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  PictureOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import type { ImageStudioRevision, ImageStudioSession } from '@/types';
import {
  formatRevisionClock,
  getRevisionPreviewAssetId,
  imageStudioAssetKey,
  mapAssetsById,
} from './image-studio-utils';
import styles from './image-studio.module.css';

interface ImageStudioRevisionStripProps {
  session: ImageStudioSession | null;
  selectedRevisionId: string;
  assetUrls: Record<string, string>;
  onSelect: (revision: ImageStudioRevision) => void;
}

function RevisionStatusIcon({ revision }: { revision: ImageStudioRevision }) {
  if (revision.status === 'running') return <SyncOutlined spin />;
  if (revision.status === 'failed') return <ExclamationCircleOutlined />;
  return <CheckOutlined />;
}

export const ImageStudioRevisionStrip: React.FC<ImageStudioRevisionStripProps> = ({
  session,
  selectedRevisionId,
  assetUrls,
  onSelect,
}) => {
  const assets = mapAssetsById(session);
  const revisions = session?.revisions || [];

  return (
    <section className={styles.revisionStrip} aria-label="修订时间线">
      <div className={styles.revisionStripHeader}>
        <div>
          <span className={styles.eyebrow}>CONTACT SHEET</span>
          <strong>修订接触印样</strong>
        </div>
        <span>{revisions.length} 帧</span>
      </div>
      <div className={styles.revisionScroller}>
        {revisions.length === 0 ? (
          <div className={styles.revisionEmpty}>首张图像生成后，修订链会固定在这里。</div>
        ) : revisions.map((revision, index) => {
          const previewAssetId = getRevisionPreviewAssetId(revision);
          const previewAsset = assets.get(previewAssetId);
          const previewUrl = previewAsset
            ? assetUrls[imageStudioAssetKey(session!.id, previewAsset.id)]
            : '';
          const selected = revision.id === selectedRevisionId;
          return (
            <button
              type="button"
              key={revision.id}
              className={`${styles.revisionCard} ${selected ? styles.revisionCardSelected : ''}`}
              onClick={() => onSelect(revision)}
              aria-pressed={selected}
            >
              <span className={styles.revisionNumber}>R{String(index + 1).padStart(2, '0')}</span>
              <span className={styles.revisionThumb}>
                {previewUrl ? <img src={previewUrl} alt="" /> : <PictureOutlined />}
              </span>
              <span className={styles.revisionInfo}>
                <span className={styles.revisionMode}>
                  {revision.mode === 'edit' ? <EditOutlined /> : <PictureOutlined />}
                  {revision.mode === 'edit' ? '编辑' : '生成'}
                </span>
                <span className={styles.revisionPrompt}>{revision.prompt}</span>
                <span className={`${styles.revisionStatus} ${styles[`revisionStatus_${revision.status}`]}`}>
                  <RevisionStatusIcon revision={revision} />
                  {revision.status === 'running' ? '处理中' : revision.status === 'failed' ? '失败' : formatRevisionClock(revision.completedAt)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};

export default ImageStudioRevisionStrip;
