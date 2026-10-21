// 预览弹窗捕获桥的纯逻辑测试：消息形状校验与格式裁决。
// 编码执行依赖真实 DOM，不在单测范围。

import { describe, expect, test } from 'bun:test';
import type { CaptureFormatAvailability } from './format-availability';
import type { CapturePreferences } from './capture-preferences';
import { createDefaultCapturePreferences } from './capture-preferences';
import {
  CAPTURE_CANCEL_TYPE,
  CAPTURE_STREAM_READY_TYPE,
  isCaptureWindowCancel,
  isCaptureWindowStreamReady,
  resolveRequestFormat
} from './preview-window-host';

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
    ...base,
    defaultFormat: overrides.defaultFormat ?? base.defaultFormat,
    enabledFormats: { ...base.enabledFormats, ...overrides.enabledFormats }
  };
}

function request(kind: 'still' | 'record', format?: string) {
  return { kind, format };
}

const DEPS = { availability: ALL_AVAILABLE, preferences: createDefaultCapturePreferences() };

describe('isCaptureWindowCancel', () => {
  test('接受带 requestId 的取消消息', () => {
    expect(
      isCaptureWindowCancel({ type: CAPTURE_CANCEL_TYPE, requestId: 'cap-1' })
    ).toBe(true);
  });

  test('拒绝错误类型、空 requestId 与非对象', () => {
    expect(isCaptureWindowCancel({ type: 'other', requestId: 'cap-1' })).toBe(false);
    expect(isCaptureWindowCancel({ type: CAPTURE_CANCEL_TYPE, requestId: '' })).toBe(false);
    expect(isCaptureWindowCancel(null)).toBe(false);
    expect(isCaptureWindowCancel('cancel')).toBe(false);
  });
});

describe('isCaptureWindowStreamReady', () => {
  const valid = {
    type: CAPTURE_STREAM_READY_TYPE,
    requestId: 'cap-1',
    kind: 'record',
    cropped: true
  };

  test('接受合法实时流就绪消息', () => {
    expect(isCaptureWindowStreamReady(valid)).toBe(true);
    expect(isCaptureWindowStreamReady({ ...valid, kind: 'still', cropped: false })).toBe(true);
  });

  test('接受可选的录制格式', () => {
    expect(isCaptureWindowStreamReady({ ...valid, format: 'webm' })).toBe(true);
    expect(isCaptureWindowStreamReady({ ...valid, format: 1 })).toBe(false);
  });

  test('拒绝错误类型、空 requestId、未知 kind 或缺失 cropped', () => {
    expect(isCaptureWindowStreamReady({ ...valid, type: 'other' })).toBe(false);
    expect(isCaptureWindowStreamReady({ ...valid, requestId: '' })).toBe(false);
    expect(isCaptureWindowStreamReady({ ...valid, kind: 'animation' })).toBe(false);
    expect(isCaptureWindowStreamReady({ ...valid, cropped: undefined })).toBe(false);
    expect(isCaptureWindowStreamReady(null)).toBe(false);
  });
});

describe('resolveRequestFormat / still', () => {
  test('未指定格式时默认 PNG', () => {
    expect(resolveRequestFormat(request('still'), DEPS)).toBe('png');
  });

  test('显式静图格式按请求采用', () => {
    expect(resolveRequestFormat(request('still', 'jpeg'), DEPS)).toBe('jpeg');
    expect(resolveRequestFormat(request('still', 'webp'), DEPS)).toBe('webp');
  });

  test('动画格式不能当静图，回退 PNG', () => {
    expect(resolveRequestFormat(request('still', 'gif'), DEPS)).toBe('png');
    expect(resolveRequestFormat(request('still', 'webm'), DEPS)).toBe('png');
  });

  test('未知格式回退 PNG', () => {
    expect(resolveRequestFormat(request('still', 'bmp'), DEPS)).toBe('png');
  });
});

describe('resolveRequestFormat / record', () => {
  test('默认偏好是静图时回退第一个可用动画格式', () => {
    expect(resolveRequestFormat(request('record'), DEPS)).toBe('gif');
  });

  test('偏好默认格式在启用与能力集合内时优先', () => {
    const deps = {
      availability: ALL_AVAILABLE,
      preferences: prefsWith({ defaultFormat: 'apng' })
    };
    expect(resolveRequestFormat(request('record'), deps)).toBe('apng');
  });

  test('偏好默认格式被关闭时回退第一个可用格式', () => {
    const deps = {
      availability: ALL_AVAILABLE,
      preferences: prefsWith({ defaultFormat: 'webm', enabledFormats: { webm: false } })
    };
    expect(resolveRequestFormat(request('record'), deps)).toBe('gif');
  });

  test('显式录制格式在可选清单内时采用', () => {
    expect(resolveRequestFormat(request('record', 'webm'), DEPS)).toBe('webm');
  });

  test('显式格式被能力探测排除时回退', () => {
    const deps = {
      availability: { ...ALL_AVAILABLE, webm: false },
      preferences: createDefaultCapturePreferences()
    };
    expect(resolveRequestFormat(request('record', 'webm'), deps)).toBe('gif');
  });

  test('静图格式或未知格式不能作为录制格式', () => {
    expect(resolveRequestFormat(request('record', 'png'), DEPS)).toBe('gif');
    expect(resolveRequestFormat(request('record', 'bmp'), DEPS)).toBe('gif');
  });

  test('全部动画格式被关闭时返回 null', () => {
    const deps = {
      availability: ALL_AVAILABLE,
      preferences: prefsWith({ enabledFormats: { gif: false, apng: false, webm: false } })
    };
    expect(resolveRequestFormat(request('record'), deps)).toBeNull();
  });
});
