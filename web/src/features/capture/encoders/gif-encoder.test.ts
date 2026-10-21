// GIF 输出尺寸守卫：桌面独立预览不再被压到 640px，保持原生 1280 长边。

import { describe, expect, test } from 'bun:test';
import { scaleGifBounds } from './gif-encoder';

describe('scaleGifBounds', () => {
  test('桌面预览按原生 1248x769 输出，不再缩到 640 长边', () => {
    expect(scaleGifBounds(1248, 769)).toEqual({ width: 1248, height: 769 });
  });

  test('手机预览保留 390x761 的完整视口', () => {
    expect(scaleGifBounds(390, 761)).toEqual({ width: 390, height: 761 });
  });

  test('超出 1280 长边的画面等比缩到高清尺寸', () => {
    expect(scaleGifBounds(2560, 1440)).toEqual({ width: 1280, height: 720 });
    expect(scaleGifBounds(1920, 1080)).toEqual({ width: 1280, height: 720 });
  });
});
