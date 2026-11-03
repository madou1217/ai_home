import { useState } from 'react';
import { Input, InputNumber, Select } from 'antd';
import {
  CloseOutlined,
  ControlOutlined,
  EditOutlined,
  FileImageOutlined,
  PictureOutlined,
  PlusOutlined,
  SendOutlined,
} from '@ant-design/icons';
import {
  IMAGE_STUDIO_MAX_OUTPUT_COUNT,
  IMAGE_STUDIO_MODERATION_OPTIONS,
  IMAGE_STUDIO_OUTPUT_FORMAT_OPTIONS,
  IMAGE_STUDIO_PROMPT_MAX_LENGTH,
  IMAGE_STUDIO_PROMPT_PRESETS,
  IMAGE_STUDIO_SIZE_VALUES,
  imageStudioBackgroundOptions,
} from '@/features/image-studio/image-studio-options';
import {
  formatImageStudioModelAvailability,
  getImageStudioQualityOptions,
} from '@/features/image-studio/image-studio-utils';
import { DetailSheet, HudChips, HudField } from '@/mobile/ui';
import type { ImageStudioModel, ImageStudioRevisionMode } from '@/types';
import type { MobileImageStudio } from './use-mobile-image-studio';
import styles from '../MobileStudio.module.css';

const OUTPUT_COUNT_OPTIONS = Array.from({ length: IMAGE_STUDIO_MAX_OUTPUT_COUNT }, (_, index) => ({
  value: index + 1,
  label: `${index + 1} 张`,
}));

/** 与桌面控制台相同的提交前置条件与阻断提示。 */
function useSubmitState(studio: MobileImageStudio) {
  const { selectedModel, prompt, mode, sourcePreviews, sourceLimit, background, outputFormat } = studio;
  const sourceOverflow = sourcePreviews.length > sourceLimit;
  const transparentJpeg = background === 'transparent' && outputFormat === 'jpeg';
  const canSubmit = Boolean(
    selectedModel
    && selectedModel.availableAccountCount > 0
    && prompt.trim()
    && (mode !== 'edit' || (sourcePreviews.length > 0 && !sourceOverflow))
    && !transparentJpeg,
  );
  const blockers = [
    !selectedModel ? '当前没有可用图片模型，请先检查账号状态。' : '',
    selectedModel && selectedModel.availableAccountCount < 1 ? formatImageStudioModelAvailability(selectedModel) : '',
    mode === 'edit' && sourcePreviews.length < 1 ? '编辑模式需要至少一张参考图，或从画布选择“继续编辑”。' : '',
    sourceOverflow ? `当前模型最多接受 ${sourceLimit} 张参考图，请移除多余图片或切换模型。` : '',
    transparentJpeg ? 'JPEG 不支持透明背景，请改用 PNG / WebP 或切换为不透明背景。' : '',
  ].filter(Boolean);
  return { canSubmit, blockers };
}

/** 拇指区常驻的提示词输入 + 生成按钮；模型、模式、参考图与参数在「制作参数」抽屉里。 */
export default function StudioComposer({ studio }: { studio: MobileImageStudio }) {
  const [paramsOpen, setParamsOpen] = useState(false);
  const { selectedModel, mode, prompt, running } = studio;
  const { canSubmit, blockers } = useSubmitState(studio);

  const submit = () => {
    if (!canSubmit || running) return;
    setParamsOpen(false);
    void studio.run();
  };

  return (
    <footer className={styles.composer} aria-label="生成与编辑控制台">
      {blockers.length ? <p className={styles.blocker} role="status">{blockers[0]}</p> : null}
      {mode === 'edit' && studio.sourcePreviews.length ? (
        <div className={styles.sourceStrip} aria-label="编辑参考图">
          {studio.sourcePreviews.map((source, index) => (
            <span className={styles.sourceThumb} key={source.key}>
              {source.previewUrl ? <img src={source.previewUrl} alt={`编辑参考图 ${index + 1}`} /> : <FileImageOutlined />}
              <button type="button" onClick={() => studio.removeSource(source.key)} aria-label={`移除参考图 ${index + 1}`}>
                <CloseOutlined />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <button type="button" className={styles.routeButton} onClick={() => setParamsOpen(true)} aria-label="打开制作参数">
        <ControlOutlined />
        <span className={styles.routeMode}>{mode === 'edit' ? '编辑' : '生成'}</span>
        <span className={styles.routeModel}>
          {selectedModel ? `${selectedModel.providerLabel} · ${selectedModel.label}` : '选择图片模型'}
        </span>
        <span className={styles.routeCounter}>{prompt.trim().length}/{IMAGE_STUDIO_PROMPT_MAX_LENGTH}</span>
      </button>
      <div className={styles.inputRow}>
        <Input.TextArea
          value={prompt}
          onChange={(event) => studio.setPrompt(event.target.value)}
          maxLength={IMAGE_STUDIO_PROMPT_MAX_LENGTH}
          autoSize={{ minRows: 1, maxRows: 5 }}
          placeholder={mode === 'edit'
            ? '说明要保留什么、改变什么，以及光线、材质、构图的目标。'
            : '描述主体、场景、构图、光线、材质与输出用途。'}
          aria-label="画面指令"
        />
        <button
          type="button"
          className={`${styles.send}${running ? ` ${styles.sendBusy}` : ''}`}
          onClick={submit}
          disabled={!canSubmit || running}
          aria-busy={running || undefined}
          aria-label={mode === 'edit' ? '生成编辑修订' : '生成新修订'}
        >
          <SendOutlined />
        </button>
      </div>

      <DetailSheet
        open={paramsOpen}
        onClose={() => setParamsOpen(false)}
        code="CONTROL DESK"
        title="制作参数"
        destroyOnClose={false}
        footer={(
          <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} onClick={submit} disabled={!canSubmit || running}>
            <SendOutlined />
            <span>{mode === 'edit' ? '生成编辑修订' : '生成新修订'}</span>
          </button>
        )}
      >
        <ComposerParameters studio={studio} blockers={blockers} />
      </DetailSheet>
    </footer>
  );
}

function ModelRow({ model, active, onSelect }: { model: ImageStudioModel; active: boolean; onSelect: () => void }) {
  const unavailable = model.availableAccountCount < 1;
  return (
    <button
      type="button"
      className={`${styles.modelRow}${active ? ` ${styles.modelRowActive}` : ''}`}
      disabled={unavailable}
      aria-pressed={active}
      onClick={onSelect}
    >
      <span className={styles.modelName}>{model.providerLabel} · {model.label}</span>
      <span className={styles.modelId}>{model.id}</span>
      <span className={`mhud-status mhud-tone--${unavailable ? 'err' : 'ok'} ${styles.modelAvailability}`}>
        <span className={`hud-led hud-led--${unavailable ? 'err' : 'ok'}`} aria-hidden="true" />
        {unavailable ? formatImageStudioModelAvailability(model) : `${model.availableAccountCount}/${model.accountCount} 可用`}
      </span>
    </button>
  );
}

function ComposerParameters({ studio, blockers }: { studio: MobileImageStudio; blockers: string[] }) {
  const { models, modelKey, selectedModel, mode, sourcePreviews, sourceLimit } = studio;
  const capabilities = selectedModel?.capabilities;
  const qualityOptions = getImageStudioQualityOptions(selectedModel);

  return (
    <div className={styles.params}>
      <HudField label="模型路线" hint={selectedModel ? formatImageStudioModelAvailability(selectedModel) : '选择图片模型'}>
        <div className={styles.modelList} role="group" aria-label="图片模型">
          {models.map((model) => (
            <ModelRow key={model.key} model={model} active={model.key === modelKey} onSelect={() => studio.setModelKey(model.key)} />
          ))}
        </div>
      </HudField>

      <div className={styles.capabilities} aria-label="模型能力">
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

      <HudField label="工作模式">
        <HudChips
          ariaLabel="工作模式"
          value={mode}
          onChange={(value) => studio.setMode(value as ImageStudioRevisionMode)}
          items={[
            { key: 'generation', label: '生成', icon: <PictureOutlined /> },
            { key: 'edit', label: '编辑', icon: <EditOutlined />, disabled: !capabilities?.edit },
          ]}
        />
      </HudField>

      {mode === 'edit' ? (
        <HudField label={`参考图与遮罩 · ${sourcePreviews.length}/${sourceLimit}`} hint="可多选 · PNG / JPEG / WebP · 单张 ≤ 4 MiB · 本地上传受 16 MiB 请求预算约束">
          <div className={styles.assetList}>
            {sourcePreviews.map((source, index) => (
              <div className={styles.assetRow} key={source.key}>
                <span className={styles.assetThumb}>
                  {source.previewUrl ? <img src={source.previewUrl} alt={`编辑参考图 ${index + 1}`} /> : <FileImageOutlined />}
                </span>
                <span className={styles.assetLabel}>{`参考 ${index + 1} · ${source.label || '当前修订资产'}`}</span>
                <button type="button" className={styles.iconButton} onClick={() => studio.removeSource(source.key)} aria-label={`移除参考图 ${index + 1}`}>
                  <CloseOutlined />
                </button>
              </div>
            ))}
            {sourcePreviews.length < sourceLimit ? (
              <label className={styles.fileButton}>
                <input
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => {
                    const files = Array.from(event.target.files || []);
                    if (files.length > 0) void studio.addSourceFiles(files);
                    event.currentTarget.value = '';
                  }}
                />
                <PlusOutlined />
                <span>{sourcePreviews.length > 0 ? '添加参考图' : '选择参考图'}</span>
              </label>
            ) : null}
            {capabilities?.mask ? (
              studio.maskPreviewUrl ? (
                <div className={styles.assetRow}>
                  <span className={styles.assetThumb}><img src={studio.maskPreviewUrl} alt="编辑遮罩" /></span>
                  <span className={styles.assetLabel}>{studio.maskLabel || '局部遮罩'}</span>
                  <button type="button" className={styles.iconButton} onClick={studio.clearMask} aria-label="移除遮罩">
                    <CloseOutlined />
                  </button>
                </div>
              ) : (
                <label className={styles.fileButton}>
                  <input
                    type="file"
                    accept="image/png"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void studio.setMaskFile(file);
                      event.currentTarget.value = '';
                    }}
                  />
                  <EditOutlined />
                  <span>可选遮罩 · 白区参与编辑 · 对第 1 张参考图生效</span>
                </label>
              )
            ) : (
              <p className={styles.note}>当前路线支持整图编辑，不接受遮罩；Studio 不会静默丢弃该语义。</p>
            )}
          </div>
        </HudField>
      ) : null}

      <HudField label="画面指令模板">
        <div className={styles.presets}>
          {IMAGE_STUDIO_PROMPT_PRESETS.map((preset) => (
            <button type="button" key={preset.label} className={styles.preset} onClick={() => studio.setPrompt(preset.value)}>
              {preset.label}
            </button>
          ))}
        </div>
      </HudField>

      {capabilities?.multiple ? (
        <HudField label="输出数量">
          <Select value={studio.outputCount} onChange={studio.setOutputCount} options={OUTPUT_COUNT_OPTIONS} aria-label="输出数量" />
        </HudField>
      ) : null}
      {capabilities?.size ? (
        <HudField label="尺寸">
          <Select value={studio.size || 'auto'} onChange={studio.setSize} options={IMAGE_STUDIO_SIZE_VALUES.map((value) => ({ value, label: value }))} aria-label="尺寸" />
        </HudField>
      ) : null}
      {capabilities?.quality ? (
        <HudField label="质量">
          <Select value={studio.quality || 'auto'} onChange={studio.setQuality} options={qualityOptions.map((value) => ({ value, label: value }))} aria-label="质量" />
        </HudField>
      ) : null}
      {capabilities?.background ? (
        <HudField label="背景">
          <Select value={studio.background || 'auto'} onChange={studio.setBackground} options={imageStudioBackgroundOptions(studio.outputFormat)} aria-label="背景" />
        </HudField>
      ) : null}
      {capabilities?.outputFormat ? (
        <HudField label="输出格式">
          <Select value={studio.outputFormat || 'png'} onChange={studio.setOutputFormat} options={IMAGE_STUDIO_OUTPUT_FORMAT_OPTIONS} aria-label="输出格式" />
        </HudField>
      ) : null}
      {capabilities?.outputCompression && (studio.outputFormat === 'jpeg' || studio.outputFormat === 'webp') ? (
        <HudField label="压缩质量">
          <InputNumber
            min={0}
            max={100}
            value={studio.outputCompression}
            onChange={(value) => studio.setOutputCompression(Number(value) || 0)}
            aria-label="压缩质量"
            inputMode="numeric"
          />
        </HudField>
      ) : null}
      {capabilities?.moderation ? (
        <HudField label="内容审核">
          <Select value={studio.moderation || 'auto'} onChange={studio.setModeration} options={IMAGE_STUDIO_MODERATION_OPTIONS} aria-label="内容审核" />
        </HudField>
      ) : null}

      {blockers.length ? (
        <div className={styles.blockers} role="status">
          {blockers.map((item) => <span key={item}>{item}</span>)}
        </div>
      ) : null}
    </div>
  );
}
