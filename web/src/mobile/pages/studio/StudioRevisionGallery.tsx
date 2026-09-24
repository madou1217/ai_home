import { CheckOutlined, EditOutlined, ExclamationCircleOutlined, PictureOutlined, SyncOutlined } from '@ant-design/icons';
import {
  formatRevisionClock,
  getRevisionPreviewAssetId,
  imageStudioAssetKey,
  mapAssetsById,
} from '@/features/image-studio/image-studio-utils';
import { EmptySignal, HudSection } from '@/mobile/ui';
import type { ImageStudioRevision } from '@/types';
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

/** 修订接触印样（单列）：点按一帧切换主画布，并滚回画布。 */
export default function StudioRevisionGallery({ studio, onSelected }: { studio: MobileImageStudio; onSelected: () => void }) {
  const { session, selectedRevision, assetUrls } = studio;
  const assets = mapAssetsById(session);
  const revisions = session?.revisions || [];

  return (
    <HudSection title="修订接触印样" code="CONTACT SHEET" count={`${revisions.length} 帧`}>
      {revisions.length === 0 ? (
        <EmptySignal title="NO FRAMES" description="首张图像生成后，修订链会固定在这里。" />
      ) : (
        <div className={styles.gallery} role="list" aria-label="修订时间线">
          {revisions.map((revision, index) => {
            const previewAsset = assets.get(getRevisionPreviewAssetId(revision));
            const previewUrl = previewAsset && session ? assetUrls[imageStudioAssetKey(session.id, previewAsset.id)] : '';
            const selected = revision.id === selectedRevision?.id;
            return (
              <button
                type="button"
                role="listitem"
                key={revision.id}
                className={`${styles.frame}${selected ? ` ${styles.frameActive}` : ''}`}
                aria-pressed={selected}
                onClick={() => {
                  studio.selectRevision(revision);
                  onSelected();
                }}
              >
                <span className={styles.frameThumb}>
                  {previewUrl ? <img src={previewUrl} alt="" /> : <PictureOutlined />}
                  <span className={styles.frameIndex}>R{String(index + 1).padStart(2, '0')}</span>
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
            );
          })}
        </div>
      )}
    </HudSection>
  );
}
