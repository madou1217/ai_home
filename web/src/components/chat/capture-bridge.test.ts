// capture-bridge 纯助手的行为测试：录制格式清单 = 启用矩阵 ∩ 浏览器探测。

import { describe, expect, test } from 'bun:test';
import type {
  CaptureEncodeSuccess,
  CaptureFormatAvailability,
  CaptureFormatId,
  CapturePreferences,
  RecordingSettings
} from '../../features/capture';
import { createDefaultCapturePreferences } from '../../features/capture';
import {
  captureProgressText,
  captureSuccessNotes,
  listRecordableAnimationFormats,
  resolveDefaultRecordFormat,
  type PreviewCaptureState
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

type PreferenceOverrides = Partial<Omit<CapturePreferences, 'enabledFormats' | 'recording'>> & {
  enabledFormats?: Partial<Record<CaptureFormatId, boolean>>;
  recording?: Partial<RecordingSettings>;
};

function prefsWith(overrides: PreferenceOverrides): CapturePreferences {
  const base = createDefaultCapturePreferences();
  return {
    ...base,
    ...overrides,
    defaultFormat: overrides.defaultFormat ?? base.defaultFormat,
    enabledFormats: { ...base.enabledFormats, ...overrides.enabledFormats },
    recording: { ...base.recording, ...overrides.recording }
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

describe('captureProgressText', () => {
  const base: PreviewCaptureState = {
    busy: true,
    kind: 'animation',
    stopping: false,
    elapsedMs: 3200,
    capturedFrames: 32,
    totalFrames: null,
    progressLabel: ''
  };

  test('手动录制显示真实秒数与已抓帧数', () => {
    expect(captureProgressText(base)).toBe('正在录制 3.2s · 32 帧');
  });

  test('固定帧数模式显示目标总数', () => {
    expect(captureProgressText({ ...base, totalFrames: 60 })).toBe('正在录制 3.2s · 32/60 帧');
  });

  test('停止后显示编码进度而不是继续计时', () => {
    expect(
      captureProgressText({ ...base, stopping: true, progressLabel: '正在编码 40%…' })
    ).toBe('正在编码 40%…');
  });

  test('首帧前显示屏幕共享请求文案', () => {
    expect(
      captureProgressText({
        ...base,
        elapsedMs: 0,
        capturedFrames: 0,
        progressLabel: '正在请求屏幕共享…'
      })
    ).toBe('正在请求屏幕共享…');
  });

  test('静图阶段显示截图请求文案', () => {
    expect(
      captureProgressText({
        ...base,
        kind: 'still',
        progressLabel: '正在请求屏幕共享…'
      })
    ).toBe('正在请求屏幕共享…');
  });

  test('静图完整页面模式直接显示渲染文案', () => {
    expect(
      captureProgressText({
        ...base,
        kind: 'still',
        elapsedMs: 0,
        capturedFrames: 0,
        progressLabel: '正在渲染完整页面…'
      })
    ).toBe('正在渲染完整页面…');
  });

  test('空闲时没有文案', () => {
    expect(captureProgressText({ ...base, busy: false, kind: null })).toBe('');
  });
});

describe('captureSuccessNotes', () => {
  const success: CaptureEncodeSuccess = {
    ok: true,
    artifact: {
      blob: new Blob(),
      mimeType: 'image/gif',
      fileExtension: 'gif',
      suggestedFileName: 'capture.gif',
      format: 'gif'
    }
  };

  test('截断提示优先出现', () => {
    expect(
      captureSuccessNotes(
        { ...success, notice: 'content_truncated', effectiveFps: 30 },
        { still: false, targetFps: 30 }
      )
    ).toEqual(['页面超出可捕获高度，底部内容已截断']);
  });

  test('实际帧率明显低于目标时如实上报', () => {
    expect(
      captureSuccessNotes({ ...success, effectiveFps: 12.3 }, { still: false, targetFps: 30 })
    ).toEqual(['实际约 12.3fps（目标 30fps）']);
  });

  test('达到目标 80% 不提示，静图不提示帧率', () => {
    expect(
      captureSuccessNotes({ ...success, effectiveFps: 24 }, { still: false, targetFps: 30 })
    ).toEqual([]);
    expect(
      captureSuccessNotes({ ...success, effectiveFps: 8 }, { still: true, targetFps: 30 })
    ).toEqual([]);
  });
});

describe('resolveDefaultRecordFormat', () => {  const options = [
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
