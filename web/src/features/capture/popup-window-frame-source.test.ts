// Region Capture 首帧守卫：裁切后的视频尺寸必须与预览元素宽高比一致。

import { describe, expect, test } from 'bun:test';
import { videoMatchesTargetAspectRatio } from './popup-window-frame-source';

describe('videoMatchesTargetAspectRatio', () => {
  test('裁切尺寸与目标宽高比一致时通过', () => {
    expect(
      videoMatchesTargetAspectRatio(1280, 720, { width: 1280, height: 720 })
    ).toBe(true);
    expect(
      videoMatchesTargetAspectRatio(2560, 1440, { width: 1280, height: 720 })
    ).toBe(true);
    // Chrome 155 实测：桌面 800x492 / 1248x769，手机 306x600 / 390x761。
    expect(
      videoMatchesTargetAspectRatio(800, 492, { width: 1248, height: 769 })
    ).toBe(true);
    expect(
      videoMatchesTargetAspectRatio(306, 600, { width: 390, height: 761 })
    ).toBe(true);
  });

  test('整窗画面在被裁到手机预览前会被拒绝', () => {
    expect(
      videoMatchesTargetAspectRatio(1920, 1080, { width: 390, height: 844 })
    ).toBe(false);
  });

  test('允许取整误差但不接受明显不同的比例', () => {
    expect(
      videoMatchesTargetAspectRatio(1279, 720, { width: 1280, height: 720 })
    ).toBe(true);
    expect(
      videoMatchesTargetAspectRatio(1200, 900, { width: 1280, height: 720 })
    ).toBe(false);
  });

  test('尺寸无效时一律未就绪', () => {
    expect(videoMatchesTargetAspectRatio(0, 720, { width: 1280, height: 720 })).toBe(false);
    expect(videoMatchesTargetAspectRatio(1280, 0, { width: 1280, height: 720 })).toBe(false);
    expect(videoMatchesTargetAspectRatio(1280, 720, { width: 0, height: 720 })).toBe(false);
  });
});
