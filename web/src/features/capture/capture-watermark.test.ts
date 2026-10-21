// 录制帧的水印接线：captureAnimation 必须在每帧导出前调用绘制层，
// 且不能直接修改帧源复用的画布（静态页面缓存会让水印逐帧累积）。

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
      drawImage() {},
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
  test('每帧导出前叠加同一水印文案，且不修改帧源画布', async () => {
    const globals = globalThis as typeof globalThis & {
      window?: unknown;
      document?: unknown;
      HTMLCanvasElement?: unknown;
    };
    const previousWindow = globals.window;
    const previousDocument = globals.document;
    const previousCanvas = globals.HTMLCanvasElement;
    const created: WatermarkCanvas[] = [];
    globals.window = globalThis;
    globals.document = {
      createElement: () => {
        const canvas = new WatermarkCanvas();
        created.push(canvas);
        return canvas;
      }
    };
    globals.HTMLCanvasElement = WatermarkCanvas;
    try {
      const shared = new WatermarkCanvas();
      const source = {
        width: 400,
        height: 200,
        async grab() {
          // 模拟静态页面缓存：每帧返回同一张画布。
          return shared;
        },
        dispose() {}
      };
      // format 故意缺失：只验证抓帧阶段的水印，不进入真实编码器。
      await captureAnimation({
        source,
        format: 'missing' as never,
        baseName: 'test',
        fps: 60,
        maxFrames: 3,
        frameCountMode: true,
        watermark: { enabled: true, provider: 'Claude', model: 'sonnet' }
      });
      expect(shared.texts).toEqual([]);
      expect(created).toHaveLength(3);
      for (const canvas of created) {
        expect(canvas.texts).toEqual(['AIH · Claude · sonnet']);
      }
    } finally {
      globals.window = previousWindow;
      globals.document = previousDocument;
      globals.HTMLCanvasElement = previousCanvas;
    }
  });
});
