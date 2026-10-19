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
  writeCapturePreferences
} from './capture-preferences';
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
  CAPTURE_REQUEST_TYPE,
  CAPTURE_RESULT_TYPE,
  ensurePreviewWindowCaptureHost,
  installPreviewWindowCaptureHost,
  isCaptureWindowRequest,
  resolveRequestFormat,
  runCaptureForWindowRequest,
  type CaptureReplyTarget,
  type CaptureWindowFailure,
  type CaptureWindowReply,
  type CaptureWindowRequest,
  type CaptureWindowRequestKind,
  type CaptureWindowSuccess,
  type ResolveRequestFormatDeps
} from './preview-window-host';
