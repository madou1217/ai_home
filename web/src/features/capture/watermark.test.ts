// 水印文案与画布绘制测试：只验证离线可断言的形状，不依赖真实 Canvas。

import { describe, expect, test } from 'bun:test';
import {
  drawCaptureWatermark,
  normalizeCaptureWatermark,
  resolveWatermarkText
} from './watermark';

class FakeContext {
  texts: string[] = [];
  fills = 0;
  strokes = 0;
  font = '';
  textAlign = '';
  textBaseline = '';
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  saved = 0;
  restored = 0;

  save() {
    this.saved += 1;
  }
  restore() {
    this.restored += 1;
  }
  beginPath() {}
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  closePath() {}
  fill() {
    this.fills += 1;
  }
  stroke() {
    this.strokes += 1;
  }
  measureText(text: string) {
    return { width: text.length * 12 };
  }
  fillText(text: string) {
    this.texts.push(text);
  }
}

function fakeCanvas(width = 1280, height = 720) {
  const context = new FakeContext();
  return {
    canvas: {
      width,
      height,
      getContext: () => context
    } as unknown as HTMLCanvasElement,
    context
  };
}

describe('watermark', () => {
  test('关闭时不绘制，开启时组合 provider 与 model', () => {
    const { canvas, context } = fakeCanvas();
    drawCaptureWatermark(canvas, { enabled: false, provider: 'Claude', model: 'x' });
    expect(context.texts).toEqual([]);
    expect(context.saved).toBe(0);

    drawCaptureWatermark(canvas, { enabled: true, provider: 'Claude', model: 'sonnet' });
    expect(context.texts[0]).toContain('AIH · Claude · sonnet');
    expect(context.fills).toBe(1);
    expect(context.strokes).toBe(1);
    expect(context.saved).toBe(1);
    expect(context.restored).toBe(1);
  });

  test('只有 provider / 只有 model 时也能生成可读文案', () => {
    expect(resolveWatermarkText({ enabled: true, provider: 'Codex' })).toBe('AIH · Codex');
    expect(resolveWatermarkText({ enabled: true, model: 'gpt-5' })).toBe('AIH · gpt-5');
    expect(resolveWatermarkText({ enabled: true })).toBe('AIH');
  });

  test('字段被裁剪且空白被去掉', () => {
    const settings = normalizeCaptureWatermark({
      enabled: true,
      provider: `  ${'p'.repeat(100)}  `,
      model: `  ${'m'.repeat(160)}  `
    });
    expect(settings.provider).toHaveLength(80);
    expect(settings.model).toHaveLength(120);
    expect(settings.provider.startsWith('p')).toBe(true);
  });

  test('缺少 2d 上下文时安静跳过', () => {
    const canvas = {
      width: 640,
      height: 480,
      getContext: () => null
    } as unknown as HTMLCanvasElement;
    expect(() =>
      drawCaptureWatermark(canvas, { enabled: true, provider: 'Claude', model: 'x' })
    ).not.toThrow();
  });
});
