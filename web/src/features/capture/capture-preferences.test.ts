// 水印与捕获范围偏好的兼容性测试：旧快照、非法值、保存与广播。

import { describe, expect, test } from 'bun:test';
import {
  createDefaultCapturePreferences,
  parseCapturePreferences,
  saveCapturePreferences,
  subscribeCapturePreferences,
  type CapturePreferencesStorage
} from './capture-preferences';

function memoryStorage(initial?: string): CapturePreferencesStorage & { value: () => string | null } {
  let raw = initial ?? null;
  return {
    getItem: () => raw,
    setItem: (_key, value) => {
      raw = value;
    },
    value: () => raw
  };
}

describe('capture preferences', () => {
  test('旧快照缺少 fps/水印/范围时回落到安全默认值', () => {
    const parsed = parseCapturePreferences(
      JSON.stringify({
        defaultFormat: 'gif',
        recording: { mode: 'duration', durationSeconds: 6 }
      })
    );
    expect(parsed.recording.fps).toBe(30);
    expect(parsed.captureScope).toBe('full');
    expect(parsed.watermark).toEqual({ enabled: false, provider: '', model: '' });
  });

  test('非法捕获范围回落到完整页面，未知水印字段被收敛', () => {
    const parsed = parseCapturePreferences(
      JSON.stringify({
        captureScope: 'viewport',
        watermark: { enabled: 'yes', provider: '  Claude  ', model: '   ' }
      })
    );
    expect(parsed.captureScope).toBe('full');
    expect(parsed.watermark).toEqual({
      enabled: false,
      provider: 'Claude',
      model: ''
    });
  });

  test('实时范围与开启的水印会被保留', () => {
    const parsed = parseCapturePreferences(
      JSON.stringify({
        captureScope: 'live',
        watermark: { enabled: true, provider: 'Codex', model: 'gpt-5' }
      })
    );
    expect(parsed.captureScope).toBe('live');
    expect(parsed.watermark.enabled).toBe(true);
    expect(parsed.watermark.provider).toBe('Codex');
  });

  test('保存会写回完整快照并广播', () => {
    const storage = memoryStorage();
    const seen: string[] = [];
    const unsubscribe = subscribeCapturePreferences((prefs) => seen.push(prefs.captureScope));
    try {
      const next = saveCapturePreferences(
        {
          ...createDefaultCapturePreferences(),
          captureScope: 'live',
          watermark: { enabled: true, provider: 'Claude', model: 'opus' }
        },
        storage
      );
      expect(next.captureScope).toBe('live');
      expect(seen).toEqual(['live']);
      expect(storage.value()).toContain('"captureScope":"live"');
      expect(storage.value()).toContain('"enabled":true');
    } finally {
      unsubscribe();
    }
  });
});
