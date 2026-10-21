// 录制时间轴的纯逻辑测试：真实帧间隔优先于目标帧率。

import { describe, expect, test } from 'bun:test';
import { captureAnimation, computeEffectiveFps, computeFrameDelays } from './capture-controller';
import { resolveFrameDelayMs } from './frame-utils';

class FakeCanvas {
  width = 40;
  height = 40;

  toDataURL(): string {
    return 'data:image/png;base64,AAAA';
  }
}

describe('computeFrameDelays', () => {
  test('中间帧按相邻真实时间戳生成时长', () => {
    expect(
      computeFrameDelays(
        [
          { dataUrl: 'a', atMs: 0 },
          { dataUrl: 'b', atMs: 250 },
          { dataUrl: 'c', atMs: 900 }
        ],
        100
      )
    ).toEqual([250, 650, 650]);
  });

  test('单帧回落到目标帧率且至少 1ms', () => {
    expect(computeFrameDelays([{ dataUrl: 'a', atMs: 0 }], 100)).toEqual([100]);
    expect(computeFrameDelays([{ dataUrl: 'a', atMs: 0 }], 0)).toEqual([1]);
  });
});

describe('computeEffectiveFps', () => {
  test('按首尾真实时间跨度计算，不补帧', () => {
    expect(
      computeEffectiveFps([
        { dataUrl: 'a', atMs: 0 },
        { dataUrl: 'b', atMs: 100 },
        { dataUrl: 'c', atMs: 250 },
        { dataUrl: 'd', atMs: 400 }
      ])
    ).toBe(7.5);
  });

  test('单帧或零跨度返回 0', () => {
    expect(computeEffectiveFps([])).toBe(0);
    expect(computeEffectiveFps([{ dataUrl: 'a', atMs: 0 }])).toBe(0);
    expect(
      computeEffectiveFps([
        { dataUrl: 'a', atMs: 10 },
        { dataUrl: 'b', atMs: 10 }
      ])
    ).toBe(0);
  });
});

describe('captureAnimation stopSignal', () => {
  test('停止信号立即结束抓帧，不再继续抓满上限', async () => {
    const globals = globalThis as typeof globalThis & {
      window?: unknown;
      HTMLCanvasElement?: unknown;
    };
    const previousWindow = globals.window;
    const previousCanvas = globals.HTMLCanvasElement;
    // capture-controller 在浏览器里使用 window.setTimeout / HTMLCanvasElement；
    // 测试只提供这两项最小能力，不依赖真实 DOM。
    globals.window = globalThis;
    globals.HTMLCanvasElement = FakeCanvas;
    try {
      let grabs = 0;
      const source = {
        width: 40,
        height: 40,
        async grab() {
          grabs += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return new FakeCanvas();
        },
        dispose() {}
      };
      const stop = new AbortController();
      const captured: number[] = [];
      const result = await captureAnimation({
        source,
        format: 'missing' as never,
        baseName: 'test',
        fps: 10,
        maxFrames: 600,
        stopSignal: stop.signal,
        onPhase: (count) => {
          captured.push(count);
          if (count === 3) stop.abort();
        }
      });
      // 编码器不存在 → 失败，但抓帧阶段必须已经被停止信号截断。
      expect(result.ok).toBe(false);
      expect(grabs).toBe(3);
      expect(captured).toEqual([1, 2, 3]);
    } finally {
      globals.window = previousWindow;
      globals.HTMLCanvasElement = previousCanvas;
    }
  });
});

describe('resolveFrameDelayMs', () => {
  test('优先使用本帧真实时长', () => {
    expect(resolveFrameDelayMs([100, 240, 80], 1, 100)).toBe(240);
  });

  test('缺失或非法值回落到目标帧率', () => {
    expect(resolveFrameDelayMs(undefined, 2, 100)).toBe(100);
    expect(resolveFrameDelayMs([100], 2, 100)).toBe(100);
    expect(resolveFrameDelayMs([0, -5, Number.NaN], 1, 40)).toBe(40);
  });
});
