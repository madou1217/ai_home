// capture 域对外统一出口。业务组件从这里 import，
// 不允许直接 import 子模块（保证域边界）。

export type {
  AnimationCaptureFormatId,
  CaptureArtifact,
  CaptureEncodeResult,
  CaptureEncoderStrategy,
  CaptureFormatDescriptor,
  CaptureFormatId,
  CaptureFrame,
  CaptureNotice,
  CaptureSurfaceDescriptor,
  EncodeAnimationRequest,
  FrameSource,
  StillCaptureFormatId
} from './types';
export {
  isAnimationCaptureFormat,
  isStillCaptureFormat
} from './types';
export {
  CAPTURE_FORMAT_CATALOG,
  buildCaptureFileName,
  getCaptureFormat,
  listAnimationFormats,
  listStillFormats
} from './format-catalog';
export {
  CAPTURE_PREFERENCES_KEY,
  CAPTURE_SCOPE_OPTIONS,
  DEFAULT_CAPTURE_SCOPE,
  type CapturePreferences,
  type CaptureScope,
  createDefaultCapturePreferences,
  normalizeCapturePreferences,
  normalizeCaptureScope,
  notifyCapturePreferences,
  parseCapturePreferences,
  readCapturePreferences,
  saveCapturePreferences,
  subscribeCapturePreferences,
  updateRecordingSettings,
  writeCapturePreferences
} from './capture-preferences';
export {
  RECORDING_DEFAULT_DURATION_SECONDS,
  RECORDING_DEFAULT_FRAME_COUNT,
  RECORDING_DEFAULT_FPS,
  RECORDING_DEFAULT_MODE,
  RECORDING_DEFAULT_SETTINGS,
  RECORDING_FPS_OPTIONS,
  RECORDING_MAX_DURATION_MS,
  RECORDING_MAX_DURATION_SECONDS,
  RECORDING_MAX_FRAMES,
  RECORDING_MIN_DURATION_SECONDS,
  RECORDING_MIN_FRAMES,
  describeRecordingSettings,
  normalizeRecordingFps,
  normalizeRecordingSettings,
  resolveRecordingPlan,
  summarizeRecordingSettings,
  type RecordingFps,
  type RecordingMode,
  type RecordingPlan,
  type RecordingSettings
} from './recording-settings';
export {
  DEFAULT_CAPTURE_WATERMARK,
  drawCaptureWatermark,
  drawCaptureWatermarkOnContext,
  normalizeCaptureWatermark,
  resolveWatermarkText,
  type CaptureWatermarkSettings
} from './watermark';
export { probeCaptureFormatAvailability, isFormatAvailable, type CaptureFormatAvailability } from './format-availability';
export { DomPreviewFrameSource } from './dom-preview-frame-source';
export {
  LivePreviewFrameSource,
  computeDisplayCrop,
  type DisplayCropInput,
  type DisplayCropResult,
  type LivePreviewFrameSourceOptions
} from './live-preview-frame-source';
export {
  captureAnimation,
  captureStill,
  downloadCaptureArtifact,
  type CaptureAnimationOptions,
  type CaptureStillOptions
} from './capture-controller';
export {
  FALLBACK_VIEWPORT_WIDTH,
  encodePreviewDocument,
  encodePreviewSource,
  type PreviewEncodeRequest,
  type PreviewSourceEncodeRequest
} from './preview-encode-dispatch';
export {
  listRecordableAnimationFormats,
  resolveDefaultRecordFormat,
  type RecordFormatOption,
  type RecordFormatOptionDeps
} from './capture-options';
export {
  CAPTURE_CANCEL_TYPE,
  CAPTURE_REQUEST_TYPE,
  CAPTURE_RESULT_TYPE,
  CAPTURE_STREAM_READY_TYPE,
  ensurePreviewWindowCaptureHost,
  installPreviewWindowCaptureHost,
  isCaptureWindowCancel,
  isCaptureWindowRequest,
  isCaptureWindowStreamReady,
  resolveRequestFormat,
  runCaptureForWindowRequest,
  runCaptureForWindowStream,
  type CaptureReplyTarget,
  type CaptureWindowCancel,
  type CaptureWindowFailure,
  type CaptureWindowProgressPhase,
  type CaptureWindowReply,
  type CaptureWindowRequest,
  type CaptureWindowRequestKind,
  type CaptureWindowStreamReady,
  type CaptureWindowSuccess,
  type ResolveRequestFormatDeps
} from './preview-window-host';
export {
  CAPTURE_TARGET_ID,
  CAPTURE_VIDEO_ID,
  PopupWindowFrameSource,
  type PopupWindowFrameSourceOptions
} from './popup-window-frame-source';
