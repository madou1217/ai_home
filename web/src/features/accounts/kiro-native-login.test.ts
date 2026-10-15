import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KIRO_NATIVE_LOGIN_POLL_FLOOR_MS,
  getKiroLoginStatusTagColor,
  getKiroLoginStatusText,
  isKiroLoginTerminal,
  resolveKiroLoginExpiryDelay,
  resolveKiroLoginPhase,
  resolveKiroLoginPollIntervalMs
} from './kiro-native-login';

test('轮询间隔：跟随服务端 interval，但不低于下限（设备码 interval 可能是 1s）', () => {
  assert.equal(resolveKiroLoginPollIntervalMs(5), 5000);
  assert.equal(resolveKiroLoginPollIntervalMs(1), KIRO_NATIVE_LOGIN_POLL_FLOOR_MS);
  assert.equal(resolveKiroLoginPollIntervalMs(0), KIRO_NATIVE_LOGIN_POLL_FLOOR_MS);
  assert.equal(resolveKiroLoginPollIntervalMs('bogus'), KIRO_NATIVE_LOGIN_POLL_FLOOR_MS);
  assert.equal(resolveKiroLoginPollIntervalMs(undefined), KIRO_NATIVE_LOGIN_POLL_FLOOR_MS);
});

test('过期判定：缺有效期视为未知（null），到点即 0', () => {
  assert.equal(resolveKiroLoginExpiryDelay(undefined), null);
  assert.equal(resolveKiroLoginExpiryDelay(0), null);
  assert.equal(resolveKiroLoginExpiryDelay(1000, 1000), 0);
  assert.equal(resolveKiroLoginExpiryDelay(5000, 1000), 4000);
  assert.equal(resolveKiroLoginExpiryDelay(1000, 5000), 0);
});

test('阶段推导：authorized 优先于本地过期；denied 不被过期吞掉；到点即 expired', () => {
  assert.equal(resolveKiroLoginPhase('authorized', Date.now() - 1000), 'authorized');
  assert.equal(resolveKiroLoginPhase('pending', 10_000, 5_000), 'pending');
  assert.equal(resolveKiroLoginPhase('pending', 1_000, 5_000), 'expired');
  assert.equal(resolveKiroLoginPhase('denied', 10_000, 5_000), 'denied');
  assert.equal(resolveKiroLoginPhase('slow_down', 10_000, 5_000), 'slow_down');
  assert.equal(resolveKiroLoginPhase('expired', 10_000, 5_000), 'expired');
});

test('终态判定与文案：只有 authorized / expired / denied / error 该停轮询', () => {
  for (const phase of ['authorized', 'expired', 'denied', 'error'] as const) {
    assert.equal(isKiroLoginTerminal(phase), true, phase);
  }
  for (const phase of ['loading', 'pending', 'slow_down'] as const) {
    assert.equal(isKiroLoginTerminal(phase), false, phase);
  }
  assert.equal(getKiroLoginStatusText('pending'), '等待授权');
  assert.equal(getKiroLoginStatusText('authorized'), '授权成功');
  assert.equal(getKiroLoginStatusText('denied'), '授权被拒绝');
  assert.equal(getKiroLoginStatusTagColor('authorized'), 'success');
  assert.equal(getKiroLoginStatusTagColor('denied'), 'warning');
  assert.equal(getKiroLoginStatusTagColor('pending'), 'default');
});
