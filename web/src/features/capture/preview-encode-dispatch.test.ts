// 整页捕获尺寸策略：静图高度上限由像素预算与宽度推导，录制保持固定上限。

import { describe, expect, test } from 'bun:test';
import {
  RECORDING_MAX_CONTENT_HEIGHT,
  STILL_MAX_CONTENT_HEIGHT,
  STILL_MAX_PIXELS,
  encodePreviewDocument,
  resolveDocumentHeightLimit
} from './preview-encode-dispatch';

describe('resolveDocumentHeightLimit', () => {
  test('静图按宽度动态推导高度上限', () => {
    expect(resolveDocumentHeightLimit(720, true)).toBe(
      Math.floor(STILL_MAX_PIXELS / 720)
    );
    expect(resolveDocumentHeightLimit(1440, true)).toBe(
      Math.floor(STILL_MAX_PIXELS / 1440)
    );
  });

  test('窄画布受硬上限保护', () => {
    expect(resolveDocumentHeightLimit(100, true)).toBe(STILL_MAX_CONTENT_HEIGHT);
  });

  test('录制始终使用固定的保守上限', () => {
    expect(resolveDocumentHeightLimit(720, false)).toBe(RECORDING_MAX_CONTENT_HEIGHT);
    expect(resolveDocumentHeightLimit(3840, false)).toBe(RECORDING_MAX_CONTENT_HEIGHT);
  });
});

describe('encodePreviewDocument', () => {
  test('拒绝用静态整页文档录制（录制必须保留实时交互）', async () => {
    await expect(
      encodePreviewDocument({
        format: 'gif',
        html: '<html><body><canvas></canvas></body></html>',
        width: 720,
        signal: new AbortController().signal,
        onPhase: () => {},
        onEncode: () => {}
      })
    ).rejects.toThrow('record_requires_live_stream');
  });
});
