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
  type CapturePreferences,
  createDefaultCapturePreferences,
  notifyCapturePreferences,
  parseCapturePreferences,
  readCapturePreferences,
  subscribeCapturePreferences,
  updateRecordingSettings,
  writeCapturePreferences
} from './capture-preferences';
export {
  RECORDING_DEFAULT_DURATION_SECONDS,
  RECORDING_DEFAULT_FRAME_COUNT,
  RECORDING_DEFAULT_MODE,
  RECORDING_DEFAULT_SETTINGS,
  RECORDING_FPS,
  RECORDING_MAX_DURATION_MS,
  RECORDING_MAX_DURATION_SECONDS,
  RECORDING_MAX_FRAMES,
  RECORDING_MIN_DURATION_SECONDS,
  RECORDING_MIN_FRAMES,
  describeRecordingSettings,
  normalizeRecordingSettings,
  resolveRecordingPlan,
  summarizeRecordingSettings,
  type RecordingMode,
  type RecordingPlan,
  type RecordingSettings
} from './recording-settings';
export { probeCaptureFormatAvailability, isFormatAvailable, type CaptureFormatAvailability } from './format-availability';
export { DomPreviewFrameSource } from './dom-preview-frame-source';
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
  type PreviewEncodeRequest
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
  ensurePreviewWindowCaptureHost,
  installPreviewWindowCaptureHost,
  isCaptureWindowCancel,
  isCaptureWindowRequest,
  resolveRequestFormat,
  runCaptureForWindowRequest,
  type CaptureReplyTarget,
  type CaptureWindowCancel,
  type CaptureWindowFailure,
  type CaptureWindowProgressPhase,
  type CaptureWindowReply,
  type CaptureWindowRequest,
  type CaptureWindowRequestKind,
  type CaptureWindowSuccess,
  type ResolveRequestFormatDeps
} from './preview-window-host';
