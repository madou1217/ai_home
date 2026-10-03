import { describe, expect, it } from 'bun:test';
import {
  serviceActionNeedsConfirm,
  servicePolicySummary,
  serviceStateTone,
  serviceSummary
} from './tool-service-presentation';

describe('tool service presentation', () => {
  it('summarizes backend, state, pid and restart count', () => {
    expect(serviceSummary({ backend: 'aih', backendLabel: 'AIH 守护', controllable: true, state: 'running', pid: 42, restarts: 2 }))
      .toBe('AIH 守护 · 运行中 · pid 42 · 已自动重启 2 次');
    expect(serviceStateTone({ backend: 'aih', controllable: true, state: 'backoff' })).toBe('warn');
  });

  it('describes policy per backend', () => {
    expect(servicePolicySummary({ backend: 'homebrew', controllable: true, state: 'running', autoRestart: true, autoStart: true }))
      .toBe('异常退出自动重启；已注册开机自启');
    expect(servicePolicySummary({ backend: 'aih', controllable: true, state: 'stopped', autoRestart: false, autoStart: true }))
      .toBe('不自动重启；随 AIH 启动');
  });

  it('confirms only disruptive actions', () => {
    expect(serviceActionNeedsConfirm('start')).toBe(false);
    expect(serviceActionNeedsConfirm('stop')).toBe(true);
    expect(serviceActionNeedsConfirm('restart')).toBe(true);
  });
});
