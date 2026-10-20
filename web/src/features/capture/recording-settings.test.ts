// 录制设置域的行为测试：旧快照收敛、三种停止计划的帧数/时长派生。

import { describe, expect, test } from 'bun:test';
import {
  RECORDING_DEFAULT_DURATION_SECONDS,
  RECORDING_DEFAULT_FRAME_COUNT,
  RECORDING_DEFAULT_FPS,
  RECORDING_DEFAULT_SETTINGS,
  RECORDING_FPS_OPTIONS,
  RECORDING_MAX_DURATION_MS,
  RECORDING_MAX_DURATION_SECONDS,
  RECORDING_MAX_FRAMES,
  RECORDING_MIN_FRAMES,
  describeRecordingSettings,
  normalizeRecordingFps,
  normalizeRecordingSettings,
  resolveRecordingPlan,
  summarizeRecordingSettings
} from './recording-settings';

describe('normalizeRecordingSettings', () => {
  test('旧快照缺字段时收敛到默认值', () => {
    expect(normalizeRecordingSettings({ mode: 'manual' })).toEqual({
      mode: 'manual',
      fps: RECORDING_DEFAULT_FPS,
      frameCount: RECORDING_DEFAULT_FRAME_COUNT,
      durationSeconds: RECORDING_DEFAULT_DURATION_SECONDS
    });
  });

  test('未知模式回落到手动停止', () => {
    expect(normalizeRecordingSettings({ mode: 'timer' as never }).mode).toBe('manual');
  });

  test('帧数与时长被夹在合法区间内', () => {
    const low = normalizeRecordingSettings({ mode: 'frames', frameCount: 0, durationSeconds: 0 });
    expect(low.frameCount).toBe(RECORDING_MIN_FRAMES);
    expect(low.durationSeconds).toBe(1);

    const high = normalizeRecordingSettings({
      mode: 'duration',
      frameCount: 99999,
      durationSeconds: 99999
    });
    expect(high.frameCount).toBe(RECORDING_MAX_FRAMES);
    expect(high.durationSeconds).toBe(RECORDING_MAX_DURATION_SECONDS);
  });

  test('非有限数字回落默认值', () => {
    const settings = normalizeRecordingSettings({
      mode: 'frames',
      frameCount: Number.NaN,
      durationSeconds: Number.POSITIVE_INFINITY
    });
    expect(settings.frameCount).toBe(RECORDING_DEFAULT_FRAME_COUNT);
    expect(settings.durationSeconds).toBe(RECORDING_DEFAULT_DURATION_SECONDS);
  });

  test('任意帧率收敛到最接近的可用档位', () => {
    expect(normalizeRecordingFps(60)).toBe(60);
    expect(normalizeRecordingFps(25)).toBe(24);
    expect(normalizeRecordingFps(58)).toBe(60);
    expect(normalizeRecordingFps(0)).toBe(RECORDING_DEFAULT_FPS);
    expect(normalizeRecordingFps(Number.NaN)).toBe(RECORDING_DEFAULT_FPS);
    expect(RECORDING_FPS_OPTIONS).toContain(normalizeRecordingFps(12));
  });
});

describe('resolveRecordingPlan', () => {
  test('手动模式使用全局硬上限且没有确定总帧数', () => {
    expect(resolveRecordingPlan(RECORDING_DEFAULT_SETTINGS)).toEqual({
      maxFrames: RECORDING_MAX_FRAMES,
      maxDurationMs: RECORDING_MAX_DURATION_MS,
      frameCountMode: false,
      fps: RECORDING_DEFAULT_FPS
    });
  });

  test('帧数模式抓满目标帧数即停', () => {
    expect(resolveRecordingPlan({ mode: 'frames', frameCount: 30 })).toEqual({
      maxFrames: 30,
      maxDurationMs: RECORDING_MAX_DURATION_MS,
      frameCountMode: true,
      fps: RECORDING_DEFAULT_FPS
    });
  });

  test('时长模式按时长与帧率换算上限', () => {
    expect(resolveRecordingPlan({ mode: 'duration', durationSeconds: 6 })).toEqual({
      maxFrames: 6 * RECORDING_DEFAULT_FPS,
      maxDurationMs: 6000,
      frameCountMode: true,
      fps: RECORDING_DEFAULT_FPS
    });
  });

  test('60fps 时长模式按 3600 帧硬上限收口', () => {
    const plan = resolveRecordingPlan({ mode: 'duration', fps: 60, durationSeconds: 60 });
    expect(plan.fps).toBe(60);
    expect(plan.maxFrames).toBe(RECORDING_MAX_FRAMES);
  });

  test('帧数模式也受 60 秒硬上限约束', () => {
    const plan = resolveRecordingPlan({ mode: 'frames', frameCount: RECORDING_MAX_FRAMES });
    expect(plan.maxDurationMs).toBe(RECORDING_MAX_DURATION_MS);
  });
});

describe('录制设置文案', () => {
  test('短摘要只给用户关心的数字', () => {
    expect(summarizeRecordingSettings({ mode: 'manual' })).toBe(`${RECORDING_DEFAULT_FPS}fps · 手动停止`);
    expect(summarizeRecordingSettings({ mode: 'frames', frameCount: 60 })).toBe(
      `${RECORDING_DEFAULT_FPS}fps · 60 帧`
    );
    expect(summarizeRecordingSettings({ mode: 'duration', durationSeconds: 6 })).toBe(
      `${RECORDING_DEFAULT_FPS}fps · 6 秒`
    );
  });

  test('完整说明同时给出帧率、帧数与时长', () => {
    expect(describeRecordingSettings({ mode: 'frames', fps: 60, frameCount: 60 })).toContain('60 fps');
    expect(describeRecordingSettings({ mode: 'frames', frameCount: 60 })).toContain('60 帧');
    expect(describeRecordingSettings({ mode: 'frames', frameCount: 60 })).toContain('2.0 秒');
    expect(describeRecordingSettings({ mode: 'duration', durationSeconds: 6 })).toContain('6 秒');
    expect(describeRecordingSettings({ mode: 'duration', durationSeconds: 6 })).toContain('180 帧');
    expect(describeRecordingSettings({ mode: 'manual' })).toContain('60 秒');
  });
});
