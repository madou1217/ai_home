import {
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  EyeOutlined,
  PictureOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import {
  formatRevisionClock,
  formatRevisionFrameLabel,
  getRevisionPreviewAssetId,
  imageStudioAssetKey,
  mapAssetsById,
} from '@/features/image-studio/image-studio-utils';
import { EmptySignal, HudSection } from '@/mobile/ui';
import type { ImageStudioAsset, ImageStudioRevision } from '@/types';
import type { MobileImageStudio } from './use-mobile-image-studio';
import styles from '../MobileStudio.module.css';

function RevisionStatus({ revision }: { revision: ImageStudioRevision }) {
  if (revision.status === 'running') {
    return <span className="mhud-status mhud-tone--info"><SyncOutlined spin />处理中</span>;
  }
  if (revision.status === 'failed') {
    return <span className="mhud-status mhud-tone--err"><ExclamationCircleOutlined />失败</span>;
  }
  return <span className="mhud-status mhud-tone--ok"><CheckOutlined />{formatRevisionClock(revision.completedAt)}</span>;
}

interface StudioRevisionGalleryProps {
  studio: MobileImageStudio;
  onSelected: () => void;
  onPreview: (revision: ImageStudioRevision, asset: ImageStudioAsset, frameLabel: string) => void;
}

/** 修订接触印样（单列）：点按一帧切换主画布并滚回画布，右侧常驻触控预览与删除入口。 */
export default function StudioRevisionGallery({ studio, onSelected, onPreview }: StudioRevisionGalleryProps) {
  const { session, selectedRevision, assetUrls, deletingRevisionId } = studio;
  const assets = mapAssetsById(session);
  const revisions = session?.revisions || [];

  return (
    <HudSection title="修订接触印样" code="CONTACT SHEET" count={`${revisions.length} 帧`}>
      {revisions.length === 0 ? (
        <EmptySignal title="NO FRAMES" description="首张图像生成后，修订链会固定在这里。" />
      ) : (
        <div className={styles.gallery} role="list" aria-label="修订时间线">
          {revisions.map((revision, index) => {
            const frameLabel = formatRevisionFrameLabel(index);
            const previewAsset = assets.get(getRevisionPreviewAssetId(revision));
            const previewUrl = previewAsset && session ? assetUrls[imageStudioAssetKey(session.id, previewAsset.id)] : '';
            const selected = revision.id === selectedRevision?.id;
            const isRunning = revision.status === 'running';
            const isDeleting = deletingRevisionId === revision.id;
            const deleteDisabled = isRunning || isDeleting;
            const deleteLabel = isRunning
              ? `${frameLabel} 正在处理中，暂不可删除`
              : isDeleting
                ? `正在删除 ${frameLabel}…`
                : `删除 ${frameLabel}`;
            return (
              <div
                role="listitem"
                key={revision.id}
                className={`${styles.frame}${selected ? ` ${styles.frameActive}` : ''}`}
              >
                <button
                  type="button"
                  className={styles.frameSelect}
                  aria-pressed={selected}
                  onClick={() => {
                    studio.selectRevision(revision);
                    onSelected();
                  }}
                >
                  <span className={styles.frameThumb}>
                    {previewUrl ? <img src={previewUrl} alt="" /> : <PictureOutlined />}
                    <span className={styles.frameIndex}>{frameLabel}</span>
                  </span>
                  <span className={styles.frameInfo}>
                    <span className={styles.frameMode}>
                      {revision.mode === 'edit' ? <EditOutlined /> : <PictureOutlined />}
                      {revision.mode === 'edit' ? '编辑' : '生成'}
                      <span className={styles.frameModel}>{revision.model}</span>
                    </span>
                    <span className={styles.framePrompt}>{revision.prompt}</span>
                    <RevisionStatus revision={revision} />
                  </span>
                </button>
                <div className={styles.frameActions}>
                  {previewAsset && previewUrl ? (
                    <button
                      type="button"
                      className={styles.frameActionButton}
                      aria-label={`预览 ${frameLabel} 全图`}
                      title={`预览 ${frameLabel} 全图`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onPreview(revision, previewAsset, frameLabel);
                      }}
                    >
                      <EyeOutlined />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`${styles.frameActionButton} ${styles.frameActionDanger}`}
                    aria-label={`删除 ${frameLabel}`}
                    title={deleteLabel}
                    disabled={deleteDisabled}
                    onClick={(event) => {
                      event.stopPropagation();
                      studio.confirmDeleteRevision(revision, frameLabel);
                    }}
                  >
                    <DeleteOutlined />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </HudSection>
  );
}
