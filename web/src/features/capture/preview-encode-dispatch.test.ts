// 整页捕获尺寸策略：静图高度上限由像素预算与宽度推导，录制保持固定上限。

import { describe, expect, test } from 'bun:test';
import {
  RECORDING_MAX_CONTENT_HEIGHT,
  STILL_MAX_CONTENT_HEIGHT,
  STILL_MAX_PIXELS,
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
