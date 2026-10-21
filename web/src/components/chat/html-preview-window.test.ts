// 预览弹窗文档的静态契约：水印身份、录制帧率与「停止」消息类型必须出现在脚本里。

import { describe, expect, test } from 'bun:test';
import {
  buildHtmlPreviewWindowDocument,
  parsePopupCaptureSettings
} from './html-preview-window';

describe('parsePopupCaptureSettings', () => {
  test('没有快照时回落到构建期默认帧率', () => {
    expect(parsePopupCaptureSettings(null, 60)).toEqual({ fps: 60 });
    expect(parsePopupCaptureSettings('', 30)).toEqual({ fps: 30 });
  });

  test('读取最新帧率并收敛到档位', () => {
    const raw = JSON.stringify({ recording: { fps: 58 } });
    expect(parsePopupCaptureSettings(raw, 30)).toEqual({ fps: 60 });
  });

  test('旧版捕获范围字段被忽略，损坏或非法值回落到默认帧率', () => {
    expect(parsePopupCaptureSettings('{oops', 15)).toEqual({ fps: 15 });
    expect(
      parsePopupCaptureSettings(
        JSON.stringify({ captureScope: 'other', recording: { fps: 0 } }),
        15
      )
    ).toEqual({ fps: 15 });
  });
});

describe('buildHtmlPreviewWindowDocument', () => {
  test('注入当前录制设置摘要', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '6 秒'
    });
    expect(doc).toContain('data-recording-hint>6 秒<');
  });

  test('弹窗包含实时屏幕共享与停止/取消协议', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'mobile',
      recordingHint: '手动停止'
    });
    expect(doc).toContain("'aih:html-preview-capture-stream-ready'");
    expect(doc).toContain("'aih:html-preview-capture-cancel'");
    expect(doc).toContain('navigator.mediaDevices.getDisplayMedia');
    expect(doc).toContain('id="aih-preview-target"');
    expect(doc).toContain('aih-capture-video');
    expect(doc).toContain('is-recording');
    expect(doc).toContain("next === 'recording' ? '停止'");
  });

  test('水印身份随打开参数注入，且不写手填全局 provider/model', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '手动停止',
      captureIdentity: { provider: 'codex', model: 'gpt-5.4' }
    });
    expect(doc).toContain('const CAPTURE_PROVIDER = "codex"');
    expect(doc).toContain('const CAPTURE_MODEL = "gpt-5.4"');
  });

  test('点击时重新读取 localStorage 的帧率', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '手动停止'
    });
    expect(doc).toContain("const CAPTURE_PREFS_KEY = 'aih.capture'");
    expect(doc).toContain('localStorage.getItem(CAPTURE_PREFS_KEY)');
    expect(doc).toContain('const readLiveCaptureSettings = function parsePopupCaptureSettings');
    expect(doc).toContain('const FALLBACK_CAPTURE_FPS = 30');
    expect(doc).toContain('currentCaptureSettings()');
    expect(doc).not.toContain('captureScope');
  });

  test('截图与录制都只走实时屏幕共享', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '手动停止'
    });
    expect(doc).not.toContain("'aih:html-preview-capture-request'");
    expect(doc).not.toContain('startDocumentCapture');
    expect(doc).toContain('startLiveCapture(kind, currentCaptureSettings().fps)');
    expect(doc).not.toContain('settings.scope');
  });

  test('产物会展示实际帧率提示', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '手动停止'
    });
    expect(doc).toContain('data.effectiveFps');
    expect(doc).toContain('data.targetFps');
    expect(doc).not.toContain('HAS_DYNAMIC_CONTENT');
    expect(doc).not.toContain('改用实时画面');
  });

  test('弹窗脚本不直接滚动页面，完整可见性交给实时帧源', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '手动停止'
    });
    expect(doc).not.toContain('scrollIntoView');
  });
});
