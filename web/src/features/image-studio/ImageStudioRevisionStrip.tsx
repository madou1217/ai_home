import React, { useMemo, useRef } from 'react';
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
import { useAppendEnter } from '@/hooks/use-append-enter';
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
  if (revision.status === 'running') return <SyncOutlined spin />;
  if (revision.status === 'failed') return <ExclamationCircleOutlined />;
  return <CheckOutlined />;
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
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // 修订只会在末尾追加（新一帧生成/编辑完成）：纯追加且增量小才逐帧进场，
  // 切会话/首屏整批挂载不播。运行中→完成是同一 id 更新，不会重播。
  const revisionKeys = useMemo(() => revisions.map((revision) => revision.id), [revisions]);
  useAppendEnter(scrollerRef, revisionKeys, session?.id || '', {
    selector: '[data-revision-card]',
    distance: 4,
  });

  return (
    <section className={styles.revisionStrip} aria-label="修订时间线">
      <div className={styles.revisionStripHeader}>
        <div>
          <span className={styles.eyebrow}>CONTACT SHEET</span>
          <strong>修订接触印样</strong>
        </div>
        <span>{revisions.length} 帧</span>
      </div>
      <div ref={scrollerRef} className={styles.revisionScroller}>
        {revisions.length === 0 ? (
          <div className={styles.revisionEmpty}>首张图像生成后，修订链会固定在这里。</div>
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
            ? `${frameLabel} 正在处理中，暂不可删除`
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
