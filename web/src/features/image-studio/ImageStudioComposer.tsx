import React from 'react';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  EditOutlined,
  FileImageOutlined,
  LoadingOutlined,
  PictureOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { Input, InputNumber, Segmented, Select, Tooltip } from 'antd';
import AppButton from '@/components/ui/AppButton';
import Reveal from '@/components/ui/Reveal';
import type { ImageStudioModel, ImageStudioRevisionMode } from '@/types';
import {
  formatImageStudioModelAvailability,
  getImageStudioQualityOptions,
} from './image-studio-utils';
import {
  IMAGE_STUDIO_MODERATION_OPTIONS,
  IMAGE_STUDIO_OUTPUT_FORMAT_OPTIONS,
  IMAGE_STUDIO_PROMPT_PRESETS as PROMPT_PRESETS,
  IMAGE_STUDIO_SIZE_VALUES,
  imageStudioBackgroundOptions,
} from './image-studio-options';
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

export interface ImageStudioComposerFeedback {
  tone: 'idle' | 'running' | 'success' | 'error';
  text: string;
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
  feedback?: ImageStudioComposerFeedback | null;
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

const OUTPUT_COUNT_OPTIONS = Array.from({ length: 10 }, (_, index) => {
  const value = index + 1;
  return { value, label: `${value} 张` };
});

interface ComposerEditAssetsSectionProps {
  sources: ImageStudioSourcePreview[];
  sourceLimit: number;
  maskSupported: boolean;
  maskPreviewUrl: string;
  maskLabel: string;
  onSourceFiles: (files: File[]) => void;
  onMaskFile: (file: File) => void;
  onRemoveSource: (key: string) => void;
  onClearMask: () => void;
}

const ComposerEditAssetsSection: React.FC<ComposerEditAssetsSectionProps> = ({
  sources,
  sourceLimit,
  maskSupported,
  maskPreviewUrl,
  maskLabel,
  onSourceFiles,
  onMaskFile,
  onRemoveSource,
  onClearMask,
}) => (
  <div className={styles.controlSection}>
    <div className={styles.fieldLabelRow}>
      <label className={styles.fieldLabel}>参考图与遮罩</label>
      <span className={styles.sourceLimit}>{sources.length}/{sourceLimit} 张参考图</span>
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
            <small>支持 PNG / JPEG / WebP，单张不超过 4 MiB</small>
          </label>
        )}
      </div>

      {maskSupported ? (
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
              <small>白色区域参与编辑，对第 1 张参考图生效</small>
            </label>
          )}
        </div>
      ) : (
        <div className={styles.maskUnavailable}>
          <span>遮罩</span>
          当前模型仅支持整图编辑，不支持局部遮罩。
        </div>
      )}
    </div>
  </div>
);

interface ComposerParametersSectionProps {
  capabilities: NonNullable<ImageStudioModel['capabilities']>;
  n: number;
  size: string;
  quality: string;
  qualityOptions: string[];
  background: string;
  outputFormat: string;
  outputCompression: number;
  moderation: string;
  onNChange: (value: number) => void;
  onSizeChange: (value: string) => void;
  onQualityChange: (value: string) => void;
  onBackgroundChange: (value: string) => void;
  onOutputFormatChange: (value: string) => void;
  onOutputCompressionChange: (value: number) => void;
  onModerationChange: (value: string) => void;
}

const ComposerParametersSection: React.FC<ComposerParametersSectionProps> = ({
  capabilities,
  n,
  size,
  quality,
  qualityOptions,
  background,
  outputFormat,
  outputCompression,
  moderation,
  onNChange,
  onSizeChange,
  onQualityChange,
  onBackgroundChange,
  onOutputFormatChange,
  onOutputCompressionChange,
  onModerationChange,
}) => (
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
          options={IMAGE_STUDIO_SIZE_VALUES.map((value) => ({ value, label: value }))}
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
          options={imageStudioBackgroundOptions(outputFormat)}
        />
      </label>
    )}
    {capabilities.outputFormat && (
      <label>
        <span>输出格式</span>
        <Select
          value={outputFormat}
          onChange={onOutputFormatChange}
          options={IMAGE_STUDIO_OUTPUT_FORMAT_OPTIONS.filter((option) => !option.value
            || !capabilities.outputFormats?.length
            || capabilities.outputFormats.includes(option.value))}
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
          options={IMAGE_STUDIO_MODERATION_OPTIONS}
        />
      </label>
    )}
  </div>
);

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
  feedback,
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
  const hasParameters = Boolean(
    capabilities
    && (capabilities.multiple
      || capabilities.size
      || capabilities.quality
      || capabilities.background
      || capabilities.outputFormat
      || capabilities.moderation),
  );
  const blockerMessage = !selectedModel
    ? '当前没有可用图片模型，请先检查账号状态。'
    : selectedModel.availableAccountCount < 1
      ? availabilityDetail
      : mode === 'edit' && sources.length < 1
        ? '编辑模式需要至少一张参考图，或从画布点击“继续编辑”。'
        : sourceOverflow
          ? `当前模型最多接受 ${sourceLimit} 张参考图，请移除多余图片或切换模型。`
          : transparentJpeg
            ? 'JPEG 不支持透明背景，请改用 PNG / WebP 或切换为不透明背景。'
            : '';

  return (
    <aside className={styles.composerPanel} aria-label="生成与编辑控制台">
      <div className={styles.composerHeader}>
        <strong className={styles.panelTitle}>参数与指令</strong>
        <span className={styles.composerCounter}>{prompt.trim().length}/12000</span>
      </div>

      <div className={styles.controlSection}>
        <label className={styles.fieldLabel} htmlFor="image-studio-model">模型</label>
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
        {capabilities && (
          <div className={styles.capabilityRow} aria-label="模型能力">
            <span data-active={Boolean(capabilities.generation)}>生成{capabilities.generation ? '可用' : '不支持'}</span>
            <span data-active={Boolean(capabilities.edit)}>编辑{capabilities.edit ? '可用' : '不支持'}</span>
            <span data-active={Boolean(capabilities.mask)}>遮罩{capabilities.mask ? '可用' : '不支持'}</span>
            <span data-active={Boolean(capabilities.multiple)}>批量{capabilities.multiple ? '可用' : '不支持'}</span>
            <span data-active={Number(capabilities.maxInputImages) > 1}>参考上限 {sourceLimit}</span>
          </div>
        )}
      </div>

      <div className={styles.controlSection}>
        <label className={styles.fieldLabel}>模式</label>
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

      <Reveal open={mode === 'edit'} keepMounted>
        <ComposerEditAssetsSection
          sources={sources}
          sourceLimit={sourceLimit}
          maskSupported={Boolean(capabilities?.mask)}
          maskPreviewUrl={maskPreviewUrl}
          maskLabel={maskLabel}
          onSourceFiles={onSourceFiles}
          onMaskFile={onMaskFile}
          onRemoveSource={onRemoveSource}
          onClearMask={onClearMask}
        />
      </Reveal>

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
          autoSize={{ minRows: 6, maxRows: 12 }}
          placeholder={mode === 'edit'
            ? '说明要保留什么、改变什么，以及光线、材质、构图的目标。'
            : '描述主体、场景、构图、光线、材质与输出用途。'}
        />
      </div>

      {hasParameters && capabilities && (
        <ComposerParametersSection
          capabilities={capabilities}
          n={n}
          size={size}
          quality={quality}
          qualityOptions={qualityOptions}
          background={background}
          outputFormat={outputFormat}
          outputCompression={outputCompression}
          moderation={moderation}
          onNChange={onNChange}
          onSizeChange={onSizeChange}
          onQualityChange={onQualityChange}
          onBackgroundChange={onBackgroundChange}
          onOutputFormatChange={onOutputFormatChange}
          onOutputCompressionChange={onOutputCompressionChange}
          onModerationChange={onModerationChange}
        />
      )}

      <div className={styles.composerSubmit}>
        {blockerMessage ? (
          <p className={styles.composerHint} role="status">{blockerMessage}</p>
        ) : null}
        {feedback && feedback.text ? (
          <div
            className={`${styles.composerFeedback} ${styles[`composerFeedback_${feedback.tone}`]}`}
            role={feedback.tone === 'error' ? 'alert' : 'status'}
            aria-live={feedback.tone === 'error' ? 'assertive' : 'polite'}
          >
            {feedback.tone === 'running' ? (
              <LoadingOutlined spin aria-hidden="true" />
            ) : feedback.tone === 'success' ? (
              <CheckCircleOutlined aria-hidden="true" />
            ) : feedback.tone === 'error' ? (
              <CloseCircleOutlined aria-hidden="true" />
            ) : null}
            <span>{feedback.text}</span>
          </div>
        ) : null}
        <AppButton
          type="primary"
          size="large"
          icon={<SendOutlined />}
          loading={running}
          disabled={!canSubmit || running}
          onClick={onSubmit}
          block
        >
          {running ? '生成中…' : mode === 'edit' ? '开始编辑' : '开始生成'}
        </AppButton>
      </div>
    </aside>
  );
};

export default ImageStudioComposer;
