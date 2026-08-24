import React from 'react';
import {
  CopyOutlined,
  DownloadOutlined,
  EditOutlined,
  LoadingOutlined,
  PictureOutlined,
  RedoOutlined,
} from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import type { ImageStudioAsset, ImageStudioRevision, ImageStudioSession } from '@/types';
import { formatAssetSize, imageStudioAssetKey, mapAssetsById } from './image-studio-utils';
import styles from './image-studio.module.css';

interface ImageStudioCanvasProps {
  session: ImageStudioSession | null;
  revision: ImageStudioRevision | null;
  selectedAsset: ImageStudioAsset | null;
  assetUrls: Record<string, string>;
  running: boolean;
  onSelectAsset: (assetId: string) => void;
  onContinueEdit: (revision: ImageStudioRevision, asset: ImageStudioAsset) => void;
  onReuseRevision: (revision: ImageStudioRevision) => void;
  onDownload: (revision: ImageStudioRevision, asset: ImageStudioAsset) => void;
  onCopyPrompt: (prompt: string) => void;
}

export const ImageStudioCanvas: React.FC<ImageStudioCanvasProps> = ({
  session,
  revision,
  selectedAsset,
  assetUrls,
  running,
  onSelectAsset,
  onContinueEdit,
  onReuseRevision,
  onDownload,
  onCopyPrompt,
}) => {
  const assets = mapAssetsById(session);
  const outputAssets = (revision?.outputAssetIds || [])
    .map((assetId) => assets.get(assetId))
    .filter((asset): asset is ImageStudioAsset => Boolean(asset));
  const selectedUrl = session && selectedAsset
    ? assetUrls[imageStudioAssetKey(session.id, selectedAsset.id)]
    : '';
  const revisedPrompt = String(selectedAsset?.revisedPrompt || '').trim();

  return (
    <section className={styles.canvasPanel} aria-label="影像画布">
      <header className={styles.canvasHeader}>
        <div>
          <span className={styles.eyebrow}>MASTER VIEW</span>
          <strong>{revision ? revision.model : '等待首个镜头'}</strong>
        </div>
        {revision && (
          <div className={styles.canvasHeaderMeta}>
            <span>{revision.provider}</span>
            <span>{revision.mode === 'edit' ? 'EDIT' : 'GENERATE'}</span>
            {selectedAsset && <span>{formatAssetSize(selectedAsset.byteLength)}</span>}
          </div>
        )}
      </header>

      <div className={styles.canvasStage}>
        {running && (
          <div className={styles.canvasProgress} role="status" aria-live="polite">
            <LoadingOutlined spin />
            <span>模型正在冲洗新修订，当前会话可留在后台。</span>
          </div>
        )}

        {!revision ? (
          <div className={styles.canvasEmpty}>
            <span className={styles.canvasEmptyMark}><PictureOutlined /></span>
            <strong>建立第一张母版</strong>
            <p>选择模型、写下画面意图，然后生成。结果会成为该会话的第一帧修订。</p>
          </div>
        ) : revision.status === 'failed' && !selectedUrl ? (
          <div className={styles.canvasEmpty}>
            <span className={`${styles.canvasEmptyMark} ${styles.canvasEmptyMarkError}`}>!</span>
            <strong>本次修订未出片</strong>
            <p>{revision.error?.message || '请检查模型可用状态或调整参数后重试。'}</p>
          </div>
        ) : selectedUrl ? (
          <div className={styles.canvasImageWrap}>
            <img src={selectedUrl} alt={revision.prompt || 'AI 生成图像'} />
          </div>
        ) : (
          <div className={styles.canvasEmpty}>
            <span className={styles.canvasEmptyMark}><LoadingOutlined spin={revision.status === 'running'} /></span>
            <strong>{revision.status === 'running' ? '正在生成' : '正在载入资产'}</strong>
            <p>大图资产通过受保护的 Studio 存储读取，不会暴露到公共 blob 缓存。</p>
          </div>
        )}
      </div>

      {revision && (
        <footer className={styles.canvasFooter}>
          <div className={styles.canvasPromptStack}>
            <div className={styles.canvasPrompt}>
              <span>PROMPT</span>
              <p>{revision.prompt}</p>
            </div>
            {revisedPrompt && revisedPrompt !== revision.prompt.trim() && (
              <div className={styles.canvasPrompt}>
                <span>REVISED PROMPT</span>
                <p>{revisedPrompt}</p>
              </div>
            )}
          </div>
          <div className={styles.canvasActions}>
            {revision.status === 'failed' && (
              <Button icon={<RedoOutlined />} onClick={() => onReuseRevision(revision)}>
                复用参数
              </Button>
            )}
            <Tooltip title="复制该帧提示词">
              <Button icon={<CopyOutlined />} onClick={() => onCopyPrompt(revision.prompt)}>
                复制提示词
              </Button>
            </Tooltip>
            {selectedAsset && selectedUrl && (
              <>
                <Button icon={<DownloadOutlined />} onClick={() => onDownload(revision, selectedAsset)}>
                  下载原图
                </Button>
                <Button
                  type="primary"
                  icon={<EditOutlined />}
                  onClick={() => onContinueEdit(revision, selectedAsset)}
                >
                  继续编辑
                </Button>
              </>
            )}
          </div>
        </footer>
      )}

      {outputAssets.length > 1 && session && (
        <div className={styles.outputPicker} aria-label="本次输出">
          {outputAssets.map((asset, index) => {
            const url = assetUrls[imageStudioAssetKey(session.id, asset.id)];
            return (
              <button
                type="button"
                key={asset.id}
                className={asset.id === selectedAsset?.id ? styles.outputPickerSelected : ''}
                onClick={() => onSelectAsset(asset.id)}
                aria-label={`选择第 ${index + 1} 张输出`}
              >
                {url ? <img src={url} alt="" /> : <PictureOutlined />}
                <span>{String(index + 1).padStart(2, '0')}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
};

export default ImageStudioCanvas;
