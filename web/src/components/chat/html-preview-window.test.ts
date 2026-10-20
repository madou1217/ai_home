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

  test('弹窗包含停止/取消协议与录制状态样式', () => {
    const doc = buildHtmlPreviewWindowDocument('<html><body>hi</body></html>', {
      device: 'mobile',
      recordingHint: '手动停止'
    });
    expect(doc).toContain("'aih:html-preview-capture-cancel'");
    expect(doc).toContain('is-recording');
    expect(doc).toContain("recordButton.textContent = recording ? '停止' : '录制'");
  });
});
