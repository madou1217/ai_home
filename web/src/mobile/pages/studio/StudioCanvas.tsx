import {
  CopyOutlined,
  DownloadOutlined,
  EditOutlined,
  LoadingOutlined,
  PictureOutlined,
  RedoOutlined,
} from '@ant-design/icons';
import { formatAssetSize, imageStudioAssetKey, mapAssetsById } from '@/features/image-studio/image-studio-utils';
import type { ImageStudioAsset } from '@/types';
import type { MobileImageStudio } from './use-mobile-image-studio';
import styles from '../MobileStudio.module.css';

/** 主画布：所选修订的所选输出 + 状态（生成中 / 失败 / 载入中 / 空会话）+ 提示词与画布操作。 */
export default function StudioCanvas({ studio }: { studio: MobileImageStudio }) {
  const { session, selectedRevision: revision, selectedAsset, assetUrls, running } = studio;
  const assets = mapAssetsById(session);
  const outputAssets = (revision?.outputAssetIds || [])
    .map((assetId) => assets.get(assetId))
    .filter((asset): asset is ImageStudioAsset => Boolean(asset));
  const selectedUrl = session && selectedAsset ? assetUrls[imageStudioAssetKey(session.id, selectedAsset.id)] : '';
  const revisedPrompt = String(selectedAsset?.revisedPrompt || '').trim();

  return (
    <section className={styles.canvas} aria-label="影像画布">
      <div className={styles.canvasHead}>
        <span className={styles.canvasModel}>{revision ? revision.model : '等待首个镜头'}</span>
        {revision ? (
          <span className={styles.canvasMeta}>
            <span>{revision.provider}</span>
            <span>{revision.mode === 'edit' ? 'EDIT' : 'GENERATE'}</span>
            {selectedAsset ? <span>{formatAssetSize(selectedAsset.byteLength)}</span> : null}
          </span>
        ) : null}
      </div>

      <div className={styles.stage}>
        {running ? (
          <div className={styles.progress} role="status" aria-live="polite">
            <LoadingOutlined spin />
            <span>模型正在冲洗新修订，当前会话可留在后台。</span>
          </div>
        ) : null}
        {!revision ? (
          <div className={styles.stageEmpty}>
            <PictureOutlined className={styles.stageMark} />
            <strong>建立第一张母版</strong>
            <p>选择模型、写下画面意图，然后生成。结果会成为该会话的第一帧修订。</p>
          </div>
        ) : revision.status === 'failed' && !selectedUrl ? (
          <div className={styles.stageEmpty}>
            <span className={`${styles.stageMark} ${styles.stageMarkError}`}>!</span>
            <strong>本次修订未出片</strong>
            <p>{revision.error?.message || '请检查模型可用状态或调整参数后重试。'}</p>
          </div>
        ) : selectedUrl ? (
          <img className={styles.stageImage} src={selectedUrl} alt={revision.prompt || 'AI 生成图像'} />
        ) : (
          <div className={styles.stageEmpty}>
            <LoadingOutlined className={styles.stageMark} spin={revision.status === 'running'} />
            <strong>{revision.status === 'running' ? '正在生成' : '正在载入资产'}</strong>
            <p>大图资产通过受保护的 Studio 存储读取，不会暴露到公共 blob 缓存。</p>
          </div>
        )}
      </div>

      {outputAssets.length > 1 && session ? (
        <div className={styles.outputs} role="group" aria-label="本次输出">
          {outputAssets.map((asset, index) => {
            const url = assetUrls[imageStudioAssetKey(session.id, asset.id)];
            const active = asset.id === selectedAsset?.id;
            return (
              <button
                type="button"
                key={asset.id}
                className={`${styles.output}${active ? ` ${styles.outputActive}` : ''}`}
                onClick={() => studio.setSelectedAssetId(asset.id)}
                aria-pressed={active}
                aria-label={`选择第 ${index + 1} 张输出`}
              >
                {url ? <img src={url} alt="" /> : <PictureOutlined />}
                <span>{String(index + 1).padStart(2, '0')}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      {revision ? (
        <>
          <div className={styles.promptBlock}>
            <span className={styles.promptLabel}>PROMPT</span>
            <p>{revision.prompt}</p>
          </div>
          {revisedPrompt && revisedPrompt !== revision.prompt.trim() ? (
            <div className={styles.promptBlock}>
              <span className={styles.promptLabel}>REVISED PROMPT</span>
              <p>{revisedPrompt}</p>
            </div>
          ) : null}
          <div className={styles.canvasActions}>
            {revision.status === 'failed' ? (
              <button type="button" className={styles.button} onClick={() => studio.reuseRevision(revision)}>
                <RedoOutlined />
                <span>复用参数</span>
              </button>
            ) : null}
            <button type="button" className={styles.button} onClick={() => void studio.copyPrompt(revision.prompt)}>
              <CopyOutlined />
              <span>复制提示词</span>
            </button>
            {selectedAsset && selectedUrl ? (
              <>
                <button type="button" className={styles.button} onClick={() => studio.download(revision, selectedAsset)}>
                  <DownloadOutlined />
                  <span>下载原图</span>
                </button>
                <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={() => studio.continueEdit(revision, selectedAsset)}>
                  <EditOutlined />
                  <span>继续编辑</span>
                </button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
