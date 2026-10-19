// capture-bridge 纯助手的行为测试：录制格式清单 = 启用矩阵 ∩ 浏览器探测。

import { describe, expect, test } from 'bun:test';
import type { CaptureFormatAvailability, CapturePreferences } from '../../features/capture';
import { createDefaultCapturePreferences } from '../../features/capture';
import {
  listRecordableAnimationFormats,
  resolveDefaultRecordFormat
} from './capture-bridge';

const ALL_AVAILABLE: CaptureFormatAvailability = {
  gif: true,
  apng: true,
  webm: true,
  mp4: false,
  png: true,
  jpeg: true,
  webp: true
};

function prefsWith(overrides: Partial<CapturePreferences>): CapturePreferences {
  const base = createDefaultCapturePreferences();
  return {
    defaultFormat: overrides.defaultFormat ?? base.defaultFormat,
    enabledFormats: { ...base.enabledFormats, ...overrides.enabledFormats }
  };
}

describe('listRecordableAnimationFormats', () => {
  test('全启用且全部可编码时列出三种动画格式', () => {
    const list = listRecordableAnimationFormats({
      availability: ALL_AVAILABLE,
      preferences: createDefaultCapturePreferences()
    });
    expect(list.map((option) => option.id)).toEqual(['gif', 'apng', 'webm']);
  });

  test('启用矩阵关闭的格式不再出现', () => {
    const prefs = prefsWith({ enabledFormats: { webm: false } });
    const list = listRecordableAnimationFormats({ availability: ALL_AVAILABLE, preferences: prefs });
    expect(list.map((option) => option.id)).toEqual(['gif', 'apng']);
  });

  test('浏览器探测不支持的格式被剔除', () => {
    const availability: CaptureFormatAvailability = { ...ALL_AVAILABLE, webm: false };
    const list = listRecordableAnimationFormats({
      availability,
      preferences: createDefaultCapturePreferences()
    });
    expect(list.map((option) => option.id)).toEqual(['gif', 'apng']);
  });
});

describe('resolveDefaultRecordFormat', () => {
  const options = [
    { id: 'gif' as const, label: 'GIF 动图' },
    { id: 'apng' as const, label: 'APNG 动图' },
    { id: 'webm' as const, label: 'WebM 动图' }
  ];

  test('全局默认格式在清单里时优先采用', () => {
    expect(resolveDefaultRecordFormat(options, prefsWith({ defaultFormat: 'apng' }))).toBe('apng');
  });

  test('全局默认格式被关闭时回退到第一个可选格式', () => {
    expect(resolveDefaultRecordFormat(options, prefsWith({ defaultFormat: 'webm', enabledFormats: { webm: false } }))).toBe('gif');
  });

  test('默认格式是静图时回退到第一个可选格式', () => {
    expect(resolveDefaultRecordFormat(options, prefsWith({ defaultFormat: 'png' }))).toBe('gif');
  });

  test('清单为空时返回 null（按钮禁用）', () => {
    expect(resolveDefaultRecordFormat([], createDefaultCapturePreferences())).toBeNull();
  });
});
