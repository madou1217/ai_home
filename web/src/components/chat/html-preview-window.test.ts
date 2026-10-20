// 预览弹窗文档的静态契约：录制条件提示与「停止」消息类型必须出现在脚本里。

import { describe, expect, test } from 'bun:test';
import { buildHtmlPreviewWindowDocument } from './html-preview-window';

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

  test('默认完整页面走文档捕获而不是屏幕共享', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '手动停止'
    });
    expect(doc).toContain("'aih:html-preview-capture-request'");
    expect(doc).toContain('startDocumentCapture');
    expect(doc).toContain("const CAPTURE_SCOPE = 'full'");
    expect(doc).toContain("const CAPTURE_FPS = 30");
  });

  test('录制启动不滚动宿主页面（避免录制瞬间跳动）', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'desktop',
      recordingHint: '手动停止'
    });
    expect(doc).not.toContain('scrollIntoView');
  });
});
