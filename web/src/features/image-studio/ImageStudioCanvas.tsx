import React from 'react';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  LoadingOutlined,
  PictureOutlined,
  RedoOutlined,
} from '@ant-design/icons';
import { Tooltip } from 'antd';
import AppButton from '@/components/ui/AppButton';
import type { ImageStudioAsset, ImageStudioRevision, ImageStudioSession } from '@/types';
import {
  formatAssetSize,
  formatRevisionFrameLabel,
  imageStudioAssetKey,
  mapAssetsById,
} from './image-studio-utils';
import styles from './image-studio.module.css';

type CanvasRunState = 'idle' | 'generating' | 'generated' | 'failed';

const CANVAS_STATE_META: Record<CanvasRunState, { label: string; className: string }> = {
  idle: { label: '未生成', className: styles.stateIdle },
  generating: { label: '生成中', className: styles.stateGenerating },
  generated: { label: '已生成', className: styles.stateGenerated },
  failed: { label: '失败', className: styles.stateFailed },
};

function resolveCanvasState(
  revision: ImageStudioRevision | null,
  selectedUrl: string,
  running: boolean,
): CanvasRunState {
  if (running || revision?.status === 'running') {
    return 'generating';
  }
  if (!revision) {
    return 'idle';
  }
  if (revision.status === 'failed' && !selectedUrl) {
    return 'failed';
  }
  if (selectedUrl || revision.status === 'succeeded') {
    return 'generated';
  }
  return 'idle';
}

interface ImageStudioCanvasProps {
  session: ImageStudioSession | null;
  revision: ImageStudioRevision | null;
  selectedAsset: ImageStudioAsset | null;
  assetUrls: Record<string, string>;
  running: boolean;
  onSelectAsset: (assetId: string) => void;
  onPreview: (revision: ImageStudioRevision, asset: ImageStudioAsset, frameLabel: string) => void;
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
  onPreview,
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
  const revisionIndex = session && revision
    ? session.revisions.findIndex((item) => item.id === revision.id)
    : -1;
  const frameLabel = revisionIndex >= 0 ? formatRevisionFrameLabel(revisionIndex) : '当前画布';
  const canvasState = resolveCanvasState(revision, selectedUrl, running);
  const stateMeta = CANVAS_STATE_META[canvasState];

  return (
    <section className={styles.canvasPanel} aria-label="影像画布">
      <header className={styles.canvasHeader}>
        <div className={styles.canvasHeaderMain}>
          <strong className={styles.panelTitle}>{revision ? revision.model : '等待首张图像'}</strong>
          <span
            className={`${styles.stateBadge} ${stateMeta.className}`}
            role={canvasState === 'failed' ? 'alert' : 'status'}
            aria-live={canvasState === 'failed' ? 'assertive' : 'polite'}
          >
            {canvasState === 'generating' ? (
              <LoadingOutlined spin aria-hidden="true" />
            ) : canvasState === 'generated' ? (
              <CheckCircleOutlined aria-hidden="true" />
            ) : canvasState === 'failed' ? (
              <CloseCircleOutlined aria-hidden="true" />
            ) : (
              <PictureOutlined aria-hidden="true" />
            )}
            <span>{stateMeta.label}</span>
          </span>
        </div>
        {revision && (
          <div className={styles.canvasHeaderMeta}>
            <span>{revision.provider}</span>
            <span>{revision.mode === 'edit' ? '编辑' : '生成'}</span>
            {selectedAsset && <span>{formatAssetSize(selectedAsset.byteLength)}</span>}
          </div>
        )}
      </header>

      <div className={styles.canvasStage}>
        {running && (
          <div className={styles.canvasProgress} role="status" aria-live="polite">
            <LoadingOutlined spin aria-hidden="true" />
            <span>生成中，当前会话可留在后台处理。</span>
          </div>
        )}

        {!revision ? (
          <div className={styles.canvasEmpty}>
            <span className={styles.canvasEmptyMark} aria-hidden="true">
              <PictureOutlined />
            </span>
            <strong>未生成图像</strong>
            <p>在右侧选择模型并输入画面描述，即可生成当前会话的第一帧。</p>
          </div>
        ) : revision.status === 'failed' && !selectedUrl ? (
          <div className={styles.canvasEmpty} role="alert">
            <span className={`${styles.canvasEmptyMark} ${styles.canvasEmptyMarkError}`} aria-hidden="true">
              <CloseCircleOutlined />
            </span>
            <strong>生成失败</strong>
            <p>{revision.error?.message || '请检查模型可用状态或调整参数后重试。'}</p>
          </div>
        ) : selectedUrl ? (
          <div className={styles.canvasImageScroll}>
            <div className={styles.canvasImageWrap}>
              <img src={selectedUrl} alt={revision.prompt || 'AI 生成图像'} />
              {selectedAsset && (
                <Tooltip title={`预览 ${frameLabel} 全图`}>
                  <button
                    type="button"
                    className={styles.canvasPreviewButton}
                    aria-label={`预览 ${frameLabel} 全图`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onPreview(revision, selectedAsset, frameLabel);
                    }}
                  >
                    <EyeOutlined />
                  </button>
                </Tooltip>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.canvasEmpty} role="status" aria-live="polite">
            <span className={styles.canvasEmptyMark} aria-hidden="true">
              <LoadingOutlined spin />
            </span>
            <strong>{revision.status === 'running' ? '生成中' : '正在读取图像'}</strong>
            <p>图像结果由本机工作台受保护存储读取。</p>
          </div>
        )}
      </div>

      {revision && (
        <footer className={styles.canvasFooter}>
          <div className={styles.canvasPromptStack}>
            <div className={styles.canvasPrompt}>
              <span>画面指令</span>
              <p>{revision.prompt}</p>
            </div>
            {revisedPrompt && revisedPrompt !== revision.prompt.trim() && (
              <div className={styles.canvasPrompt}>
                <span>模型改写指令</span>
                <p>{revisedPrompt}</p>
              </div>
            )}
          </div>
          <div className={styles.canvasActions}>
            {revision.status === 'failed' && (
              <AppButton icon={<RedoOutlined />} onClick={() => onReuseRevision(revision)}>
                复用参数
              </AppButton>
            )}
            <Tooltip title="复制该帧提示词">
              <AppButton icon={<CopyOutlined />} onClick={() => onCopyPrompt(revision.prompt)}>
                复制提示词
              </AppButton>
            </Tooltip>
            {selectedAsset && selectedUrl && (
              <>
                <AppButton icon={<DownloadOutlined />} onClick={() => onDownload(revision, selectedAsset)}>
                  下载原图
                </AppButton>
                <AppButton
                  type="primary"
                  icon={<EditOutlined />}
                  onClick={() => onContinueEdit(revision, selectedAsset)}
                >
                  继续编辑
                </AppButton>
              </>
            )}
          </div>
        </footer>
      )}

      {outputAssets.length > 1 && session && (
        <div className={styles.outputPicker} aria-label="本次输出">
          {outputAssets.map((asset, index) => {
            const url = assetUrls[imageStudioAssetKey(session.id, asset.id)];
            const isSelected = asset.id === selectedAsset?.id;
            return (
              <button
                type="button"
                key={asset.id}
                className={isSelected ? styles.outputPickerSelected : ''}
                onClick={() => onSelectAsset(asset.id)}
                aria-label={`选择第 ${index + 1} 张输出`}
                aria-pressed={isSelected}
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
