// 水印偏好的兼容性测试：旧快照、未知字段、保存与广播。
// 水印只持久化开关；provider/model 在捕获时从当前会话身份解析。

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
  test('旧快照缺少 fps/水印时回落到安全默认值', () => {
    const parsed = parseCapturePreferences(
      JSON.stringify({
        defaultFormat: 'gif',
        recording: { mode: 'duration', durationSeconds: 6 }
      })
    );
    expect(parsed.recording.fps).toBe(30);
    expect(parsed.watermark).toEqual({ enabled: false });
    expect(parsed.previewDevice).toBe('desktop');
  });

  test('默认预览设备独立持久化，未知值回落到 PC', () => {
    expect(parseCapturePreferences(JSON.stringify({ previewDevice: 'mobile' })).previewDevice).toBe(
      'mobile'
    );
    expect(
      parseCapturePreferences(JSON.stringify({ previewDevice: 'tablet' })).previewDevice
    ).toBe('desktop');

    const storage = memoryStorage();
    const saved = saveCapturePreferences(
      { ...createDefaultCapturePreferences(), previewDevice: 'mobile' },
      storage
    );
    expect(saved.previewDevice).toBe('mobile');
    expect(storage.value()).toContain('"previewDevice":"mobile"');
  });

  test('旧版捕获范围被忽略，未知水印字段被收敛为仅开关', () => {
    const parsed = parseCapturePreferences(
      JSON.stringify({
        captureScope: 'viewport',
        watermark: { enabled: 'yes', provider: '  Claude  ', model: '   ' }
      })
    );
    expect('captureScope' in parsed).toBe(false);
    expect(parsed.watermark).toEqual({ enabled: false });
  });

  test('开启的水印开关会被保留，手填 provider/model 不进入偏好', () => {
    const parsed = parseCapturePreferences(
      JSON.stringify({
        captureScope: 'live',
        watermark: { enabled: true, provider: 'Codex', model: 'gpt-5' }
      })
    );
    expect(parsed.watermark).toEqual({ enabled: true });
  });

  test('保存会写回完整快照并广播', () => {
    const storage = memoryStorage();
    const seen: boolean[] = [];
    const unsubscribe = subscribeCapturePreferences((prefs) => seen.push(prefs.watermark.enabled));
    try {
      const next = saveCapturePreferences(
        {
          ...createDefaultCapturePreferences(),
          watermark: { enabled: true }
        },
        storage
      );
      expect(next.watermark.enabled).toBe(true);
      expect(seen).toEqual([true]);
      expect(storage.value()).toContain('"enabled":true');
      expect(storage.value()).not.toContain('captureScope');
      expect(storage.value()).not.toContain('provider');
    } finally {
      unsubscribe();
    }
  });
});
