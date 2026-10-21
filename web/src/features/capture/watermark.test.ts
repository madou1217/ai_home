// 预览水印的纯逻辑测试：文案解析与「弹幕式」随机分布布局。
// 水印只存在于预览层，不再有 canvas 烧录取样（录制产物必须干净）。

import { describe, expect, test } from 'bun:test';
import {
  buildPreviewWatermarkMarks,
  normalizeCaptureWatermark,
  resolveCaptureWatermark,
  resolveWatermarkText
} from './watermark';

describe('水印文案', () => {
  test('关闭时不生成文案，开启时组合 provider 与 model', () => {
    expect(resolveWatermarkText({ enabled: false, provider: 'Claude', model: 'x' })).toBe('');
    expect(
      resolveWatermarkText({ enabled: true, provider: 'Claude', model: 'sonnet' })
    ).toBe('AIH · Claude · sonnet');
  });

  test('只有 provider / 只有 model 时也能生成可读文案', () => {
    expect(resolveWatermarkText({ enabled: true, provider: 'Codex' })).toBe('AIH · Codex');
    expect(resolveWatermarkText({ enabled: true, model: 'gpt-5' })).toBe('AIH · gpt-5');
    expect(resolveWatermarkText({ enabled: true })).toBe('AIH');
  });

  test('偏好只保留开关，会话身份在预览时裁剪并注入', () => {
    const preference = normalizeCaptureWatermark({ enabled: true });
    expect(preference).toEqual({ enabled: true });
    const settings = resolveCaptureWatermark(preference, {
      provider: `  ${'p'.repeat(100)}  `,
      model: `  ${'m'.repeat(160)}  `
    });
    expect(settings.enabled).toBe(true);
    expect(settings.provider).toHaveLength(80);
    expect(settings.model).toHaveLength(120);
    expect(settings.provider.startsWith('p')).toBe(true);
  });

  test('未知开关值收敛为关闭', () => {
    expect(normalizeCaptureWatermark({ enabled: 'yes' as never })).toEqual({ enabled: false });
  });
});

describe('预览水印布局', () => {
  test('没有文案或尺寸非法时不产生标记', () => {
    expect(buildPreviewWatermarkMarks({ text: '', width: 800, height: 600 })).toEqual([]);
    expect(buildPreviewWatermarkMarks({ text: 'AIH', width: 0, height: 600 })).toEqual([]);
    expect(
      buildPreviewWatermarkMarks({ text: 'AIH', width: Number.NaN, height: 600 })
    ).toEqual([]);
  });

  test('同一文案与尺寸生成稳定布局（重渲染不跳动）', () => {
    const input = { text: 'AIH · codex · gpt-5', width: 1248, height: 769 };
    expect(buildPreviewWatermarkMarks(input)).toEqual(buildPreviewWatermarkMarks(input));
  });

  test('标记铺满画面并保持很浅的透明度', () => {
    const marks = buildPreviewWatermarkMarks({
      text: 'AIH · claude · sonnet',
      width: 1280,
      height: 720
    });
    expect(marks.length).toBeGreaterThanOrEqual(4);
    expect(marks.length).toBeLessThanOrEqual(30);
    const lefts = marks.map((mark) => mark.leftPct);
    const tops = marks.map((mark) => mark.topPct);
    // 左右、上下都要有分布，避免全部挤在一角。
    expect(Math.min(...lefts)).toBeLessThan(30);
    expect(Math.max(...lefts)).toBeGreaterThan(70);
    expect(Math.min(...tops)).toBeLessThan(30);
    expect(Math.max(...tops)).toBeGreaterThan(70);
    for (const mark of marks) {
      expect(mark.text).toBe('AIH · claude · sonnet');
      expect(mark.leftPct).toBeGreaterThan(0);
      expect(mark.leftPct).toBeLessThan(100);
      expect(mark.topPct).toBeGreaterThan(0);
      expect(mark.topPct).toBeLessThan(100);
      expect(mark.opacity).toBeGreaterThan(0.05);
      expect(mark.opacity).toBeLessThan(0.2);
      expect(mark.fontSizePx).toBeGreaterThanOrEqual(11);
      expect(mark.fontSizePx).toBeLessThanOrEqual(16);
      expect(Math.abs(mark.rotateDeg)).toBeLessThanOrEqual(12);
    }
  });

  test('小尺寸预览不会堆叠过多水印', () => {
    const marks = buildPreviewWatermarkMarks({
      text: 'AIH',
      width: 390,
      height: 761
    });
    expect(marks.length).toBeGreaterThanOrEqual(4);
    expect(marks.length).toBeLessThanOrEqual(12);
  });
});
