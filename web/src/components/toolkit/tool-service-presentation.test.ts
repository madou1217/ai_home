import assert from 'node:assert/strict';
import test from 'node:test';

import {
  serviceActionNeedsConfirm,
  servicePolicySummary,
  serviceStateTone,
  serviceSummary
} from './tool-service-presentation.ts';

test('summarizes backend, state, pid and restart count', () => {
  assert.equal(
    serviceSummary({ backend: 'aih', backendLabel: 'AIH 守护', controllable: true, state: 'running', pid: 42, restarts: 2 }),
    'AIH 守护 · 运行中 · pid 42 · 已自动重启 2 次'
  );
  assert.equal(serviceStateTone({ backend: 'aih', controllable: true, state: 'backoff' }), 'warn');
});

test('describes policy per backend', () => {
  assert.equal(
    servicePolicySummary({ backend: 'homebrew', controllable: true, state: 'running', autoRestart: true, autoStart: true }),
    '异常退出自动重启；已注册开机自启'
  );
  assert.equal(
    servicePolicySummary({ backend: 'aih', controllable: true, state: 'stopped', autoRestart: false, autoStart: true }),
    '不自动重启；随 AIH 启动'
  );
});

test('confirms only disruptive actions', () => {
  assert.equal(serviceActionNeedsConfirm('start'), false);
  assert.equal(serviceActionNeedsConfirm('stop'), true);
  assert.equal(serviceActionNeedsConfirm('restart'), true);
});
