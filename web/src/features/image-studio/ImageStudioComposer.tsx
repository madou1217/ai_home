import React from 'react';
import {
  CloseOutlined,
  EditOutlined,
  FileImageOutlined,
  PictureOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { Button, Input, InputNumber, Segmented, Select, Tooltip } from 'antd';
import type { ImageStudioModel, ImageStudioRevisionMode } from '@/types';
import {
  formatImageStudioModelAvailability,
  getImageStudioQualityOptions,
} from './image-studio-utils';
import styles from './image-studio.module.css';

const { TextArea } = Input;

export interface ImageStudioUploadValue {
  name: string;
  dataUrl: string;
  mimeType: string;
  size: number;
}

export interface ImageStudioSourcePreview {
  key: string;
  previewUrl: string;
  label: string;
}

interface ImageStudioComposerProps {
  models: ImageStudioModel[];
  modelKey: string;
  mode: ImageStudioRevisionMode;
  prompt: string;
  n: number;
  size: string;
  quality: string;
  background: string;
  outputFormat: string;
  outputCompression: number;
  moderation: string;
  sources: ImageStudioSourcePreview[];
  sourceLimit: number;
  maskPreviewUrl: string;
  maskLabel: string;
  running: boolean;
  onModelChange: (modelKey: string) => void;
  onModeChange: (mode: ImageStudioRevisionMode) => void;
  onPromptChange: (prompt: string) => void;
  onNChange: (value: number) => void;
  onSizeChange: (value: string) => void;
  onQualityChange: (value: string) => void;
  onBackgroundChange: (value: string) => void;
  onOutputFormatChange: (value: string) => void;
  onOutputCompressionChange: (value: number) => void;
  onModerationChange: (value: string) => void;
  onSourceFiles: (files: File[]) => void;
  onMaskFile: (file: File) => void;
  onRemoveSource: (key: string) => void;
  onClearMask: () => void;
  onSubmit: () => void;
}

const PROMPT_PRESETS = [
  {
    label: '产品母版',
    value: 'Editorial product portrait on a warm neutral sweep, precise material texture, restrained shadows, art-directed studio light.',
  },
  {
    label: '空间概念',
    value: 'Architectural concept frame with disciplined geometry, natural material palette, cinematic daylight, human-scale details.',
  },
  {
    label: '视觉系统',
    value: 'A clear visual system study presented as a contact sheet, consistent subject, varied composition and lighting, production-ready art direction.',
  },
];

const OUTPUT_COUNT_OPTIONS = Array.from({ length: 10 }, (_, index) => {
  const value = index + 1;
  return { value, label: `${value} 张` };
});

export const ImageStudioComposer: React.FC<ImageStudioComposerProps> = ({
  models,
  modelKey,
  mode,
  prompt,
  n,
  size,
  quality,
  background,
  outputFormat,
  outputCompression,
  moderation,
  sources,
  sourceLimit,
  maskPreviewUrl,
  maskLabel,
  running,
  onModelChange,
  onModeChange,
  onPromptChange,
  onNChange,
  onSizeChange,
  onQualityChange,
  onBackgroundChange,
  onOutputFormatChange,
  onOutputCompressionChange,
  onModerationChange,
  onSourceFiles,
  onMaskFile,
  onRemoveSource,
  onClearMask,
  onSubmit,
}) => {
  const selectedModel = models.find((model) => model.key === modelKey) || null;
  const capabilities = selectedModel?.capabilities;
  const availabilityDetail = selectedModel
    ? formatImageStudioModelAvailability(selectedModel)
    : '';
  const qualityOptions = getImageStudioQualityOptions(selectedModel);
  const sourceOverflow = sources.length > sourceLimit;
  const transparentJpeg = background === 'transparent' && outputFormat === 'jpeg';
  const canSubmit = Boolean(
    selectedModel
    && selectedModel.availableAccountCount > 0
    && prompt.trim()
    && (mode !== 'edit' || (sources.length > 0 && !sourceOverflow))
    && !transparentJpeg,
  );

  return (
    <aside className={styles.composerPanel} aria-label="生成与编辑控制台">
      <div className={styles.composerHeader}>
        <div>
          <span className={styles.eyebrow}>CONTROL DESK</span>
          <strong>制作控制台</strong>
        </div>
        <span className={styles.composerCounter}>{prompt.trim().length}/12000</span>
      </div>

      <div className={styles.controlSection}>
        <label className={styles.fieldLabel} htmlFor="image-studio-model">模型路线</label>
        <Select
          id="image-studio-model"
          value={modelKey || undefined}
          onChange={onModelChange}
          className={styles.modelSelect}
          placeholder="选择图片模型"
          optionLabelProp="label"
          options={models.map((model) => ({
            value: model.key,
            label: `${model.providerLabel} · ${model.label} · ${model.availableAccountCount}/${model.accountCount} 可用`,
            disabled: model.availableAccountCount < 1,
            title: model.availableAccountCount < 1
              ? formatImageStudioModelAvailability(model)
              : undefined,
          }))}
        />
        {selectedModel && (
          <div className={styles.modelReadout}>
            <span>{selectedModel.providerLabel}</span>
            <code>{selectedModel.id}</code>
            <span>{availabilityDetail}</span>
          </div>
        )}
        <div className={styles.capabilityRow} aria-label="模型能力">
          <span data-active={Boolean(capabilities?.generation)}>生成</span>
          <span data-active={Boolean(capabilities?.edit)}>编辑</span>
          <span data-active={Boolean(capabilities?.mask)}>遮罩</span>
          <span data-active={Boolean(capabilities?.multiple)}>批量</span>
          <span data-active={Number(capabilities?.maxInputImages) > 1}>参考×{sourceLimit}</span>
          <span data-active={Boolean(capabilities?.size)}>尺寸</span>
          <span data-active={Boolean(capabilities?.quality)}>质量</span>
          <span data-active={Boolean(capabilities?.background)}>背景</span>
          <span data-active={Boolean(capabilities?.outputFormat)}>格式</span>
        </div>
      </div>

      <div className={styles.controlSection}>
        <label className={styles.fieldLabel}>工作模式</label>
        <Segmented
          block
          value={mode}
          onChange={(value) => onModeChange(value as ImageStudioRevisionMode)}
          options={[
            { label: '生成', value: 'generation', icon: <PictureOutlined /> },
            { label: '编辑', value: 'edit', icon: <EditOutlined />, disabled: !capabilities?.edit },
          ]}
        />
      </div>

      {mode === 'edit' && (
        <div className={styles.controlSection}>
          <div className={styles.fieldLabelRow}>
            <label className={styles.fieldLabel}>参考图与遮罩</label>
            <span className={styles.sourceLimit}>{sources.length}/{sourceLimit} REFERENCES</span>
          </div>
          <div className={styles.assetInputs}>
            <div className={styles.sourceStack}>
              <div className={styles.sourceList}>
                {sources.map((source, index) => (
                  <div className={styles.assetPreview} key={source.key}>
                    {source.previewUrl
                      ? <img src={source.previewUrl} alt={`编辑参考图 ${index + 1}`} />
                      : <div className={styles.assetPreviewFallback}><FileImageOutlined /></div>}
                    <span>{`参考 ${index + 1} · ${source.label || '当前修订资产'}`}</span>
                    <Tooltip title="移除参考图">
                      <button type="button" onClick={() => onRemoveSource(source.key)} aria-label={`移除参考图 ${index + 1}`}><CloseOutlined /></button>
                    </Tooltip>
                  </div>
                ))}
              </div>
              {sources.length < sourceLimit && (
                <label className={styles.assetDropLabel}>
                  <input
                    type="file"
                    multiple
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => {
                      const files = Array.from(event.target.files || []);
                      if (files.length > 0) onSourceFiles(files);
                      event.currentTarget.value = '';
                    }}
                  />
                  <FileImageOutlined />
                  <span>{sources.length > 0 ? '添加参考图' : '选择参考图'}</span>
                  <small>可多选 · PNG / JPEG / WebP · 单张 ≤ 4 MiB · 本地上传受 16 MiB 请求预算约束</small>
                </label>
              )}
            </div>

            {capabilities?.mask ? (
              <div className={styles.assetInputSlot}>
                {maskPreviewUrl ? (
                  <div className={styles.assetPreview}>
                    <img src={maskPreviewUrl} alt="编辑遮罩" />
                    <span>{maskLabel || '局部遮罩'}</span>
                    <Tooltip title="移除遮罩">
                      <button type="button" onClick={onClearMask} aria-label="移除遮罩"><CloseOutlined /></button>
                    </Tooltip>
                  </div>
                ) : (
                  <label className={styles.assetDropLabel}>
                    <input
                      type="file"
                      accept="image/png"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) onMaskFile(file);
                        event.currentTarget.value = '';
                      }}
                    />
                    <EditOutlined />
                    <span>可选遮罩</span>
                    <small>白区参与编辑 · 对第 1 张参考图生效</small>
                  </label>
                )}
              </div>
            ) : (
              <div className={styles.maskUnavailable}>
                <span>MASK</span>
                当前路线支持整图编辑，不接受遮罩；Studio 不会静默丢弃该语义。
              </div>
            )}
          </div>
        </div>
      )}

      <div className={`${styles.controlSection} ${styles.promptSection}`}>
        <div className={styles.fieldLabelRow}>
          <label className={styles.fieldLabel} htmlFor="image-studio-prompt">画面指令</label>
          <div className={styles.presetRow}>
            {PROMPT_PRESETS.map((preset) => (
              <button type="button" key={preset.label} onClick={() => onPromptChange(preset.value)}>
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        <TextArea
          id="image-studio-prompt"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          maxLength={12000}
          autoSize={{ minRows: 7, maxRows: 14 }}
          placeholder={mode === 'edit'
            ? '说明要保留什么、改变什么，以及光线、材质、构图的目标。'
            : '描述主体、场景、构图、光线、材质与输出用途。'}
        />
      </div>

      {(capabilities?.multiple
        || capabilities?.size
        || capabilities?.quality
        || capabilities?.background
        || capabilities?.outputFormat
        || capabilities?.moderation) && (
        <div className={styles.parameterGrid}>
          {capabilities.multiple && (
            <label>
              <span>输出数量</span>
              <Select value={n} onChange={onNChange} options={OUTPUT_COUNT_OPTIONS} />
            </label>
          )}
          {capabilities.size && (
            <label>
              <span>尺寸</span>
              <Select
                value={size || 'auto'}
                onChange={onSizeChange}
                options={['auto', '1024x1024', '1536x1024', '1024x1536'].map((value) => ({ value, label: value }))}
              />
            </label>
          )}
          {capabilities.quality && (
            <label>
              <span>质量</span>
              <Select
                value={quality || 'auto'}
                onChange={onQualityChange}
                options={qualityOptions.map((value) => ({ value, label: value }))}
              />
            </label>
          )}
          {capabilities.background && (
            <label>
              <span>背景</span>
              <Select
                value={background || 'auto'}
                onChange={onBackgroundChange}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'opaque', label: '不透明' },
                  { value: 'transparent', label: '透明', disabled: outputFormat === 'jpeg' },
                ]}
              />
            </label>
          )}
          {capabilities.outputFormat && (
            <label>
              <span>输出格式</span>
              <Select
                value={outputFormat || 'png'}
                onChange={onOutputFormatChange}
                options={[
                  { value: 'png', label: 'PNG' },
                  { value: 'jpeg', label: 'JPEG' },
                  { value: 'webp', label: 'WebP' },
                ]}
              />
            </label>
          )}
          {capabilities.outputCompression && (outputFormat === 'jpeg' || outputFormat === 'webp') && (
            <label>
              <span>压缩质量</span>
              <InputNumber
                min={0}
                max={100}
                value={outputCompression}
                onChange={(value) => onOutputCompressionChange(Number(value) || 0)}
              />
            </label>
          )}
          {capabilities.moderation && (
            <label>
              <span>内容审核</span>
              <Select
                value={moderation || 'auto'}
                onChange={onModerationChange}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'low', label: '低限制' },
                ]}
              />
            </label>
          )}
        </div>
      )}

      <div className={styles.composerSubmit}>
        {!selectedModel && <span>当前没有可用图片模型，请先检查账号状态。</span>}
        {selectedModel && selectedModel.availableAccountCount < 1 && <span>{availabilityDetail}</span>}
        {mode === 'edit' && sources.length < 1 && <span>编辑模式需要至少一张参考图，或从画布选择“继续编辑”。</span>}
        {sourceOverflow && <span>当前模型最多接受 {sourceLimit} 张参考图，请移除多余图片或切换模型。</span>}
        {transparentJpeg && <span>JPEG 不支持透明背景，请改用 PNG / WebP 或切换为不透明背景。</span>}
        <Button
          type="primary"
          size="large"
          icon={<SendOutlined />}
          loading={running}
          disabled={!canSubmit || running}
          onClick={onSubmit}
          block
        >
          {mode === 'edit' ? '生成编辑修订' : '生成新修订'}
        </Button>
      </div>
    </aside>
  );
};

export default ImageStudioComposer;
