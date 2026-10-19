import type {
  AnimationCaptureFormatId,
  CaptureFormatDescriptor,
  CaptureFormatId,
  StillCaptureFormatId
} from './types';
import { isAnimationCaptureFormat, isStillCaptureFormat } from './types';

const STILL_FORMATS: Record<StillCaptureFormatId, CaptureFormatDescriptor> = {
  png: {
    id: 'png',
    kind: 'still',
    label: 'PNG 静图',
    mimeType: 'image/png',
    fileExtension: 'png',
    requiresFramePipeline: false,
    defaultEnabled: true
  },
  jpeg: {
    id: 'jpeg',
    kind: 'still',
    label: 'JPEG 静图',
    mimeType: 'image/jpeg',
    fileExtension: 'jpg',
    requiresFramePipeline: false,
    defaultEnabled: true,
    quality: 0.92
  },
  webp: {
    id: 'webp',
    kind: 'still',
    label: 'WebP 静图',
    mimeType: 'image/webp',
    fileExtension: 'webp',
    requiresFramePipeline: false,
    defaultEnabled: true,
    quality: 0.9
  }
};

const ANIMATION_FORMATS: Record<AnimationCaptureFormatId, CaptureFormatDescriptor> = {
  gif: {
    id: 'gif',
    kind: 'animation',
    label: 'GIF 动图',
    mimeType: 'image/gif',
    fileExtension: 'gif',
    requiresFramePipeline: true,
    defaultEnabled: true
  },
  apng: {
    id: 'apng',
    kind: 'animation',
    label: 'APNG 动图',
    mimeType: 'image/apng',
    fileExtension: 'png',
    requiresFramePipeline: true,
    defaultEnabled: true
  },
  webm: {
    id: 'webm',
    kind: 'animation',
    label: 'WebM 视频',
    mimeType: 'video/webm',
    fileExtension: 'webm',
    requiresFramePipeline: true,
    defaultEnabled: true
  }
};

export const CAPTURE_FORMAT_CATALOG: readonly CaptureFormatDescriptor[] = [
  STILL_FORMATS.png,
  STILL_FORMATS.jpeg,
  STILL_FORMATS.webp,
  ANIMATION_FORMATS.gif,
  ANIMATION_FORMATS.apng,
  ANIMATION_FORMATS.webm
];

export function getCaptureFormat(id: CaptureFormatId): CaptureFormatDescriptor {
  const found = CAPTURE_FORMAT_CATALOG.find((item) => item.id === id);
  if (!found) throw new Error(`capture_format_unknown: ${id}`);
  return found;
}

export function listStillFormats(): CaptureFormatDescriptor[] {
  return CAPTURE_FORMAT_CATALOG.filter((item) => isStillCaptureFormat(item.id));
}

export function listAnimationFormats(): CaptureFormatDescriptor[] {
  return CAPTURE_FORMAT_CATALOG.filter((item) => isAnimationCaptureFormat(item.id));
}

export function buildCaptureFileName(baseName: string, id: CaptureFormatId): string {
  return `${baseName || 'capture'}-${Date.now()}.${getCaptureFormat(id).fileExtension}`;
}
