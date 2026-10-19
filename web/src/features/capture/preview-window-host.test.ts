// 预览弹窗捕获桥的纯逻辑测试：消息形状校验与格式裁决。
// 编码执行（encodePreviewDocument）依赖真实 DOM，不在单测范围。

import { describe, expect, test } from 'bun:test';
import type { CaptureFormatAvailability } from './format-availability';
import type { CapturePreferences } from './capture-preferences';
import { createDefaultCapturePreferences } from './capture-preferences';
import {
  CAPTURE_REQUEST_TYPE,
  isCaptureWindowRequest,
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
    defaultFormat: overrides.defaultFormat ?? base.defaultFormat,
    enabledFormats: { ...base.enabledFormats, ...overrides.enabledFormats }
  };
}

function request(kind: 'still' | 'record', format?: string) {
  return { kind, format };
}

const DEPS = { availability: ALL_AVAILABLE, preferences: createDefaultCapturePreferences() };

describe('isCaptureWindowRequest', () => {
  const valid = {
    type: CAPTURE_REQUEST_TYPE,
    requestId: 'cap-1',
    kind: 'still',
    html: '<html><body>hi</body></html>',
    width: 720
  };

  test('接受合法 still/record 请求', () => {
    expect(isCaptureWindowRequest(valid)).toBe(true);
    expect(isCaptureWindowRequest({ ...valid, kind: 'record' })).toBe(true);
  });

  test('拒绝错误消息类型', () => {
    expect(isCaptureWindowRequest({ ...valid, type: 'other' })).toBe(false);
  });

  test('拒绝空 requestId 或未知 kind', () => {
    expect(isCaptureWindowRequest({ ...valid, requestId: '' })).toBe(false);
    expect(isCaptureWindowRequest({ ...valid, kind: 'animation' })).toBe(false);
  });

  test('拒绝空文档与 nil', () => {
    expect(isCaptureWindowRequest({ ...valid, html: '' })).toBe(false);
    expect(isCaptureWindowRequest(null)).toBe(false);
    expect(isCaptureWindowRequest('capture')).toBe(false);
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
