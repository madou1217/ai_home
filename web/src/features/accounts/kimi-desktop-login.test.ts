import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KIMI_DESKTOP_SESSION_POLL_MS,
  getKimiDesktopSessionStatusTagColor,
  getKimiDesktopSessionStatusText,
  resolveKimiDesktopPollPhase,
  resolveKimiDesktopSessionExpiryDelay
} from './kimi-desktop-login.ts';

test('getKimiDesktopSessionStatusText 覆盖全部轮询状态文案', () => {
  assert.equal(getKimiDesktopSessionStatusText('loading'), '正在生成二维码…');
  assert.equal(getKimiDesktopSessionStatusText('error'), '二维码获取失败');
  assert.equal(getKimiDesktopSessionStatusText('STATUS_PENDING'), '请用微信扫码');
  assert.equal(getKimiDesktopSessionStatusText('STATUS_SCANNED'), '已扫码，请在微信中确认登录');
  assert.equal(getKimiDesktopSessionStatusText('STATUS_EXPIRED'), '二维码已过期');
  assert.equal(getKimiDesktopSessionStatusText('STATUS_SUCCESS'), '登录成功');
});

test('getKimiDesktopSessionStatusTagColor 区分进行/告警/成功状态', () => {
  assert.equal(getKimiDesktopSessionStatusTagColor('STATUS_SCANNED'), 'processing');
  assert.equal(getKimiDesktopSessionStatusTagColor('STATUS_EXPIRED'), 'warning');
  assert.equal(getKimiDesktopSessionStatusTagColor('error'), 'warning');
  assert.equal(getKimiDesktopSessionStatusTagColor('STATUS_SUCCESS'), 'success');
  assert.equal(getKimiDesktopSessionStatusTagColor('STATUS_PENDING'), 'default');
  assert.equal(getKimiDesktopSessionStatusTagColor('loading'), 'default');
});

test('轮询间隔为 2 秒', () => {
  assert.equal(KIMI_DESKTOP_SESSION_POLL_MS, 2000);
});

test('二维码截止时间拒绝无效值并把剩余时间收敛到非负数', () => {
  assert.equal(resolveKimiDesktopSessionExpiryDelay(10_000, 4_000), 6_000);
  assert.equal(resolveKimiDesktopSessionExpiryDelay(3_000, 4_000), 0);
  assert.equal(resolveKimiDesktopSessionExpiryDelay(undefined, 4_000), null);
  assert.equal(resolveKimiDesktopSessionExpiryDelay('invalid', 4_000), null);
});

test('已发出的官方成功响应赢得本地过期竞态', () => {
  assert.equal(resolveKimiDesktopPollPhase('STATUS_PENDING', 3_000, 4_000), 'STATUS_EXPIRED');
  assert.equal(resolveKimiDesktopPollPhase('STATUS_SCANNED', 3_000, 4_000), 'STATUS_EXPIRED');
  assert.equal(resolveKimiDesktopPollPhase('STATUS_SUCCESS', 3_000, 4_000), 'STATUS_SUCCESS');
});
