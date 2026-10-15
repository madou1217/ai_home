import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WINDOW_ACTIVATION_ENABLE_COMMAND,
  describeWindowActivationGlobal,
  describeWindowActivationOutcome,
  formatWindowActivationInterval
} from '@/features/accounts/window-activation-presentation';

test('间隔毫秒按人话格式化，非法值返回空串', () => {
  assert.equal(formatWindowActivationInterval(60 * 1000), '1 分钟');
  assert.equal(formatWindowActivationInterval(90 * 60 * 1000), '1 小时 30 分钟');
  assert.equal(formatWindowActivationInterval(4 * 60 * 60 * 1000), '4 小时');
  assert.equal(formatWindowActivationInterval(0), '');
  assert.equal(formatWindowActivationInterval(null), '');
  assert.equal(formatWindowActivationInterval(Number.NaN), '');
});

test('探测结果码翻译成人话，未知码与 HTTP 码不掩盖原因', () => {
  assert.equal(describeWindowActivationOutcome('activated'), '已激活窗口');
  assert.equal(describeWindowActivationOutcome('http_429'), '探测返回 HTTP 429');
  assert.equal(describeWindowActivationOutcome('no_probe_model'), '该账号目录里没有可用的探测模型');
  assert.equal(describeWindowActivationOutcome('weird_code'), 'weird_code');
  assert.equal(describeWindowActivationOutcome(''), '');
});

test('全局未开启时明确说明「打开账号开关也不会探测」并给出开启命令', () => {
  const view = describeWindowActivationGlobal({
    global: {
      enabled: false,
      savedEnabled: false,
      restartRequired: false,
      defaultIntervalMs: 4 * 60 * 60 * 1000,
      minIntervalMs: 60 * 60 * 1000
    }
  });
  assert.equal(view.tone, 'inactive');
  assert.equal(view.label, '未生效');
  assert.match(view.text, /全局开关未开启/);
  assert.equal(view.hints.some((hint) => hint.includes(WINDOW_ACTIVATION_ENABLE_COMMAND)), true);
});

test('全局已生效时显示真实默认间隔，并提示尚无探测记录', () => {
  const view = describeWindowActivationGlobal({
    global: {
      enabled: true,
      savedEnabled: true,
      restartRequired: false,
      defaultIntervalMs: 4 * 60 * 60 * 1000,
      minIntervalMs: 60 * 60 * 1000
    },
    accountEnabled: true,
    lastProbe: { at: 0, outcome: '' }
  });
  assert.equal(view.tone, 'active');
  assert.equal(view.label, '已生效');
  assert.match(view.text, /每 4 小时/);
  assert.equal(view.hints.length, 1);
  assert.match(view.hints[0], /还没有探测记录/);
});

test('已保存但未生效要提示重启，且有探测记录时显示相对时间与结果', () => {
  const view = describeWindowActivationGlobal({
    global: {
      enabled: false,
      savedEnabled: true,
      restartRequired: true,
      defaultIntervalMs: 4 * 60 * 60 * 1000,
      minIntervalMs: 60 * 60 * 1000
    },
    lastProbe: { at: 1792000000000, outcome: 'activated' },
    lastProbeRelative: '12 分钟前'
  });
  assert.equal(view.hints.includes('全局开关已保存，重启 Server 后生效。'), true);
  assert.equal(view.hints.includes('上次探测：12 分钟前 · 已激活窗口'), true);
});

test('宿主未上报运行态时按「状态未知」表达，不假装已开启', () => {
  const view = describeWindowActivationGlobal({ global: null });
  assert.equal(view.tone, 'unknown');
  assert.equal(view.label, '状态未知');
  assert.match(view.text, /未上报/);
});
