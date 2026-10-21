// 实时取景裁切换算的纯函数测试：Retina、部分离屏、窗口边框偏移与最大宽度。

import { describe, expect, test } from 'bun:test';
import {
  computeDisplayCrop,
  isTargetFullyVisible,
  revealCaptureTarget
} from './live-preview-frame-source';

describe('computeDisplayCrop', () => {
  test('Retina 视频像素按视口比例换算', () => {
    const crop = computeDisplayCrop({
      videoWidth: 2880,
      videoHeight: 1800,
      viewportWidth: 1440,
      viewportHeight: 900,
      rect: { left: 100, top: 50, width: 720, height: 400 }
    });
    expect(crop).toEqual({
      sx: 200,
      sy: 100,
      sw: 1440,
      sh: 800,
      width: 720,
      height: 400
    });
  });

  test('元素部分离屏时只裁可见区域', () => {
    const crop = computeDisplayCrop({
      videoWidth: 1000,
      videoHeight: 800,
      viewportWidth: 1000,
      viewportHeight: 800,
      rect: { left: -100, top: 700, width: 400, height: 200 }
    });
    expect(crop).toEqual({
      sx: 0,
      sy: 700,
      sw: 300,
      sh: 100,
      width: 300,
      height: 100
    });
  });

  test('窗口捕获多出浏览器边框时按偏移裁切', () => {
    const crop = computeDisplayCrop({
      videoWidth: 1000,
      videoHeight: 860,
      viewportWidth: 1000,
      viewportHeight: 800,
      rect: { left: 20, top: 80, width: 600, height: 400 },
      viewportOffset: { x: 0, y: 60 }
    });
    expect(crop).toEqual({
      sx: 20,
      sy: 140,
      sw: 600,
      sh: 400,
      width: 600,
      height: 400
    });
  });

  test('超过最大宽度时等比缩小输出画布', () => {
    const crop = computeDisplayCrop({
      videoWidth: 3000,
      videoHeight: 2000,
      viewportWidth: 1500,
      viewportHeight: 1000,
      rect: { left: 0, top: 0, width: 1500, height: 1000 },
      maxWidth: 1280
    });
    expect(crop?.width).toBe(1280);
    expect(crop?.height).toBe(853);
    expect(crop?.sw).toBe(3000);
    expect(crop?.sh).toBe(2000);
  });

  test('完全不可见或尺寸非法时返回 null', () => {
    expect(
      computeDisplayCrop({
        videoWidth: 1000,
        videoHeight: 800,
        viewportWidth: 1000,
        viewportHeight: 800,
        rect: { left: 1200, top: 0, width: 300, height: 200 }
      })
    ).toBeNull();
    expect(
      computeDisplayCrop({
        videoWidth: 0,
        videoHeight: 800,
        viewportWidth: 1000,
        viewportHeight: 800,
        rect: { left: 0, top: 0, width: 300, height: 200 }
      })
    ).toBeNull();
  });
});

describe('录制前让目标完整可见', () => {
  const viewport = { width: 1000, height: 800 };

  function fakeTarget(
    rect: { left: number; top: number; width: number; height: number },
    onScroll?: () => void
  ): HTMLElement {
    return {
      getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
      scrollIntoView: (options: ScrollIntoViewOptions) => {
        expect(options.block).toBe('center');
        onScroll?.();
      }
    } as unknown as HTMLElement;
  }

  test('完整落在视口内时不滚动', () => {
    let scrolled = false;
    const target = fakeTarget({ left: 100, top: 100, width: 800, height: 380 }, () => {
      scrolled = true;
    });
    revealCaptureTarget(target, viewport);
    expect(scrolled).toBe(false);
    expect(isTargetFullyVisible(target, viewport)).toBe(true);
  });

  test('被聊天滚动区裁掉时滚动到中央', () => {
    let scrolled = false;
    const target = fakeTarget({ left: 0, top: 600, width: 1000, height: 380 }, () => {
      scrolled = true;
    });
    revealCaptureTarget(target, viewport);
    expect(scrolled).toBe(true);
  });

  test('目标仍不完整可见时判定失败（不静默录半截）', () => {
    const target = fakeTarget({ left: 0, top: 500, width: 1000, height: 380 });
    expect(isTargetFullyVisible(target, viewport)).toBe(false);
  });
});
