// 预览弹窗文档的静态契约：预览水印、录制帧率与「停止」消息类型必须出现在脚本里。

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

  test('预览水印来自当前会话身份，只渲染在预览层', () => {
    const globals = globalThis as typeof globalThis & { window?: unknown };
    const previousWindow = globals.window;
    globals.window = {
      localStorage: {
        getItem: () => JSON.stringify({ watermark: { enabled: true } })
      }
    };
    let doc = '';
    try {
      doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
        device: 'desktop',
        recordingHint: '手动停止',
        captureIdentity: { provider: 'codex', model: 'gpt-5.4' }
      });
    } finally {
      globals.window = previousWindow;
    }
    expect(doc).toContain('const WATERMARK_TEXT = "AIH · codex · gpt-5.4"');
    expect(doc).toContain('data-watermark-layer');
    expect(doc).toContain('const buildWatermarkMarks =');
    expect(doc).not.toContain('CAPTURE_PROVIDER');
    expect(doc).not.toContain('CAPTURE_MODEL');
    // 抓帧前后必须切换水印可见性，产物里不能留下水印。
    expect(doc).toContain('setWatermarkHidden(true)');
    expect(doc).toContain('setWatermarkHidden(false)');
  });

  test('水印默认关闭时不渲染任何水印标记', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '手动停止'
    });
    expect(doc).toContain('const WATERMARK_TEXT = ""');
    expect(doc).toContain('data-watermark-layer aria-hidden="true" hidden');
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
    expect(doc).toContain('startLiveCapture(');
    expect(doc).toContain('currentCaptureSettings().fps');
    expect(doc).not.toContain('settings.scope');
  });

  test('自动录制意图会在页面渲染完成后等待裁切尺寸稳定', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '手动停止',
      autoCapture: { kind: 'record', format: 'webm' }
    });
    expect(doc).toContain('const AUTO_CAPTURE_KIND = "record"');
    expect(doc).toContain('const AUTO_CAPTURE_FORMAT = "webm"');
    expect(doc).toContain("'aih:html-preview-capture-auto-start'");
    expect(doc).toContain('startLiveCapture(');
    expect(doc).toContain('currentCaptureSettings().fps');
    expect(doc).toContain('preview.addEventListener(\'load\', markPreviewLoaded)');
    expect(doc).toContain('await previewReady;');
    expect(doc).toContain('waitForStablePopupVideo');
    expect(doc).toContain('requestVideoFrameCallback');
    expect(doc).toContain('format: format || undefined');
    expect(doc).toContain('is-auto-ready');
    expect(doc).toContain('页面已渲染完成');
    expect(doc).toContain('点击「');
    const previewReadyAt = doc.indexOf('await previewReady;');
    const cropAt = doc.indexOf('CropTarget.fromElement(preview)');
    const videoAt = doc.indexOf('video.srcObject = stream');
    expect(previewReadyAt).toBeGreaterThan(-1);
    expect(cropAt).toBeGreaterThan(previewReadyAt);
    expect(videoAt).toBeGreaterThan(cropAt);
  });

  test('没有自动录制意图时不启用自动启动', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '手动停止'
    });
    expect(doc).toContain('const AUTO_CAPTURE_KIND = ""');
    expect(doc).toContain('const AUTO_CAPTURE_FORMAT = ""');
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
