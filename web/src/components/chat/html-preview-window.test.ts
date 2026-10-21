// 预览弹窗文档的静态契约：录制条件提示与「停止」消息类型必须出现在脚本里。

import { describe, expect, test } from 'bun:test';
import {
  buildHtmlPreviewWindowDocument,
  parsePopupCaptureSettings
} from './html-preview-window';

describe('parsePopupCaptureSettings', () => {
  test('没有快照时回落到构建期默认值', () => {
    expect(parsePopupCaptureSettings(null, 'live', 60)).toEqual({ scope: 'live', fps: 60 });
    expect(parsePopupCaptureSettings('', 'full', 30)).toEqual({ scope: 'full', fps: 30 });
  });

  test('读取最新捕获范围并把帧率收敛到档位', () => {
    const raw = JSON.stringify({ captureScope: 'live', recording: { fps: 58 } });
    expect(parsePopupCaptureSettings(raw, 'full', 30)).toEqual({ scope: 'live', fps: 60 });
  });

  test('损坏或未知字段回落到默认值', () => {
    expect(parsePopupCaptureSettings('{oops', 'full', 30)).toEqual({ scope: 'full', fps: 30 });
    expect(
      parsePopupCaptureSettings(JSON.stringify({ captureScope: 'other', recording: { fps: 0 } }), 'live', 15)
    ).toEqual({ scope: 'full', fps: 15 });
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

  test('点击时重新读取 localStorage 的捕获范围与帧率', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '手动停止'
    });
    expect(doc).toContain("const CAPTURE_PREFS_KEY = 'aih.capture'");
    expect(doc).toContain('localStorage.getItem(CAPTURE_PREFS_KEY)');
    expect(doc).toContain('const readLiveCaptureSettings = function parsePopupCaptureSettings');
    expect(doc).toContain("const FALLBACK_CAPTURE_SCOPE = \"full\"");
    expect(doc).toContain('const FALLBACK_CAPTURE_FPS = 30');
    expect(doc).toContain('currentCaptureSettings()');
    expect(doc).not.toContain("const CAPTURE_SCOPE = 'full'");
  });

  test('默认完整页面走文档捕获而不是屏幕共享', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '手动停止'
    });
    expect(doc).toContain("'aih:html-preview-capture-request'");
    expect(doc).toContain('startDocumentCapture');
    expect(doc).toContain('settings.scope ===');
    expect(doc).toContain('startLiveCapture(kind, settings.fps)');
  });

  test('产物会展示截断、实际帧率与脚本检测提示', () => {
    const doc = buildHtmlPreviewWindowDocument(
      '<html><body><script>1</script><canvas></canvas></body></html>',
      { device: 'desktop', recordingHint: '手动停止' }
    );
    expect(doc).toContain("data.notice === 'content_truncated'");
    expect(doc).toContain('data.effectiveFps');
    expect(doc).toContain('data.targetFps');
    expect(doc).toContain('const HAS_DYNAMIC_CONTENT = true');
    expect(doc).toContain("action.className = 'status-action'");
    expect(doc).toContain('改用实时画面');
  });

  test('静态文档不注入脚本检测提示', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '手动停止'
    });
    expect(doc).toContain('const HAS_DYNAMIC_CONTENT = false');
  });

  test('录制启动不滚动宿主页面（避免录制瞬间跳动）', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '手动停止'
    });
    expect(doc).not.toContain('scrollIntoView');
  });
});
