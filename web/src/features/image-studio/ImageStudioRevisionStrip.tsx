import React from 'react';
import {
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  PictureOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { Tooltip } from 'antd';
import type { ImageStudioAsset, ImageStudioRevision, ImageStudioSession } from '@/types';
import {
  formatRevisionClock,
  formatRevisionFrameLabel,
  getRevisionPreviewAssetId,
  imageStudioAssetKey,
  mapAssetsById,
} from './image-studio-utils';
import styles from './image-studio.module.css';

interface ImageStudioRevisionStripProps {
  session: ImageStudioSession | null;
  selectedRevisionId: string;
  deletingRevisionId: string;
  assetUrls: Record<string, string>;
  onSelect: (revision: ImageStudioRevision) => void;
  onPreview: (revision: ImageStudioRevision, asset: ImageStudioAsset, frameLabel: string) => void;
  onDelete: (revision: ImageStudioRevision, frameLabel: string) => void;
}

function RevisionStatusIcon({ revision }: { revision: ImageStudioRevision }) {
  if (revision.status === 'running') return <SyncOutlined spin aria-hidden="true" />;
  if (revision.status === 'failed') return <ExclamationCircleOutlined aria-hidden="true" />;
  return <CheckOutlined aria-hidden="true" />;
}

function revisionStatusText(revision: ImageStudioRevision) {
  if (revision.status === 'running') return '生成中';
  if (revision.status === 'failed') return '失败';
  const clock = formatRevisionClock(revision.completedAt);
  return clock ? `已生成 · ${clock}` : '已生成';
}

export const ImageStudioRevisionStrip: React.FC<ImageStudioRevisionStripProps> = ({
  session,
  selectedRevisionId,
  deletingRevisionId,
  assetUrls,
  onSelect,
  onPreview,
  onDelete,
}) => {
  const assets = mapAssetsById(session);
  const revisions = session?.revisions || [];

  return (
    <section className={styles.revisionStrip} aria-label="修订记录">
      <div className={styles.revisionStripHeader}>
        <strong className={styles.panelTitle}>修订记录</strong>
        <span className={styles.panelCount}>{revisions.length} 帧</span>
      </div>
      <div className={styles.revisionScroller}>
        {revisions.length === 0 ? (
          <div className={styles.revisionEmpty}>未生成修订，完成一次生成后会按顺序显示在这里。</div>
        ) : revisions.map((revision, index) => {
          const frameLabel = formatRevisionFrameLabel(index);
          const previewAssetId = getRevisionPreviewAssetId(revision);
          const previewAsset = assets.get(previewAssetId);
          const previewUrl = session && previewAsset
            ? assetUrls[imageStudioAssetKey(session.id, previewAsset.id)]
            : '';
          const selected = revision.id === selectedRevisionId;
          const isRunning = revision.status === 'running';
          const isDeleting = deletingRevisionId === revision.id;
          const deleteDisabled = isRunning || isDeleting;
          const deleteTooltip = isRunning
            ? `${frameLabel} 生成中，暂不可删除`
            : isDeleting
              ? `正在删除 ${frameLabel}…`
              : `删除 ${frameLabel}`;
          return (
            <div
              key={revision.id}
              data-revision-card
              className={`${styles.revisionCard} ${selected ? styles.revisionCardSelected : ''}`}
            >
              <div className={styles.revisionThumbSlot}>
                <button
                  type="button"
                  className={styles.revisionThumbSelect}
                  onClick={() => onSelect(revision)}
                  aria-label={`选择 ${frameLabel}`}
                  tabIndex={-1}
                >
                  <span className={styles.revisionThumb}>
                    {previewUrl ? <img src={previewUrl} alt="" /> : <PictureOutlined />}
                  </span>
                </button>
                <span className={styles.revisionNumber}>{frameLabel}</span>
                {previewAsset && previewUrl && (
                  <Tooltip title={`预览 ${frameLabel} 全图`}>
                    <button
                      type="button"
                      className={styles.revisionPreviewButton}
                      aria-label={`预览 ${frameLabel} 全图`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onPreview(revision, previewAsset, frameLabel);
                      }}
                    >
                      <EyeOutlined />
                    </button>
                  </Tooltip>
                )}
              </div>
              <button
                type="button"
                className={styles.revisionBody}
                onClick={() => onSelect(revision)}
                aria-pressed={selected}
              >
                <span className={styles.revisionInfo}>
                  <span className={styles.revisionMode}>
                    {revision.mode === 'edit' ? <EditOutlined aria-hidden="true" /> : <PictureOutlined aria-hidden="true" />}
                    {revision.mode === 'edit' ? '编辑' : '生成'}
                  </span>
                  <span className={styles.revisionPrompt}>{revision.prompt}</span>
                  <span className={`${styles.revisionStatus} ${styles[`revisionStatus_${revision.status}`]}`}>
                    <RevisionStatusIcon revision={revision} />
                    <span>{revisionStatusText(revision)}</span>
                  </span>
                </span>
              </button>
              <Tooltip title={deleteTooltip}>
                <span className={styles.revisionDeleteWrap}>
                  <button
                    type="button"
                    className={styles.revisionDeleteButton}
                    aria-label={`删除 ${frameLabel}`}
                    disabled={deleteDisabled}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(revision, frameLabel);
                    }}
                  >
                    <DeleteOutlined />
                  </button>
                </span>
              </Tooltip>
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default ImageStudioRevisionStrip;
