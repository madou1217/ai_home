// 录制帧的水印接线：captureAnimation 必须在每帧导出前调用绘制层。

import { describe, expect, test } from 'bun:test';
import { captureAnimation } from './capture-controller';

class WatermarkCanvas {
  width = 400;
  height = 200;
  texts: string[] = [];

  getContext() {
    return {
      save() {},
      restore() {},
      measureText(text: string) {
        return { width: text.length * 4 };
      },
      beginPath() {},
      moveTo() {},
      lineTo() {},
      quadraticCurveTo() {},
      closePath() {},
      fill() {},
      stroke() {},
      fillText: (text: string) => {
        this.texts.push(text);
      },
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: '',
      textBaseline: ''
    };
  }

  toDataURL(): string {
    return 'data:image/png;base64,AAAA';
  }
}

describe('captureAnimation watermark', () => {
  test('每帧导出前叠加同一水印文案', async () => {
    const globals = globalThis as typeof globalThis & {
      window?: unknown;
      HTMLCanvasElement?: unknown;
    };
    const previousWindow = globals.window;
    const previousCanvas = globals.HTMLCanvasElement;
    globals.window = globalThis;
    globals.HTMLCanvasElement = WatermarkCanvas;
    try {
      const canvases: WatermarkCanvas[] = [];
      const source = {
        width: 400,
        height: 200,
        async grab() {
          const canvas = new WatermarkCanvas();
          canvases.push(canvas);
          return canvas;
        },
        dispose() {}
      };
      // format 故意缺失：只验证抓帧阶段的水印，不进入真实编码器。
      await captureAnimation({
        source,
        format: 'missing' as never,
        baseName: 'test',
        fps: 60,
        maxFrames: 2,
        frameCountMode: true,
        watermark: { enabled: true, provider: 'Claude', model: 'sonnet' }
      });
      expect(canvases).toHaveLength(2);
      for (const canvas of canvases) {
        expect(canvas.texts).toEqual(['AIH · Claude · sonnet']);
      }
    } finally {
      globals.window = previousWindow;
      globals.HTMLCanvasElement = previousCanvas;
    }
  });
});
