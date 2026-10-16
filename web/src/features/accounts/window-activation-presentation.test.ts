import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WINDOW_ACTIVATION_ENABLE_COMMAND,
  describeWindowActivationGlobal,
  describeWindowActivationOutcome,
  describeWindowActivationWindow,
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

test('全局已生效时显示真实默认间隔（兜底节奏），并提示尚无探测记录', () => {
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
  // 主触发是「窗口关闭后」，间隔只是观察不到窗口时的兜底节奏 —— 文案必须说清这一点。
  assert.match(view.text, /窗口关闭后/);
  assert.match(view.text, /4 小时/);
  assert.match(view.text, /兜底/);
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

test('账号窗口状态：窗口运行中说清关窗时刻与自动续窗', () => {
  const now = 1_800_000_000_000;
  const closeAtMs = now + 90 * 60 * 1000;
  const view = describeWindowActivationWindow({
    window: {
      kind: 'open',
      anchorAtMs: closeAtMs - 300 * 60 * 1000,
      closeAtMs,
      windowMinutes: 300,
      remainingMs: 90 * 60 * 1000,
      source: 'probe',
      observedAtMs: closeAtMs - 300 * 60 * 1000,
      nextActionAtMs: closeAtMs + 60 * 1000,
      probeFailureCount: 0,
      lastDecision: { action: 'skip', reason: 'window_open', at: now - 60 * 1000 }
    },
    closeAtText: '10-16 18:50',
    decisionAtText: '1 分钟前',
    nowMs: now
  });
  assert.ok(view);
  assert.equal(view?.tone, 'active');
  assert.equal(view?.label, '窗口运行中');
  assert.match(String(view?.text), /10-16 18:50 关闭/);
  assert.match(String(view?.text), /还剩 1 小时 30 分钟/);
  assert.match(String(view?.text), /关闭后自动补一次探测续窗/);
  assert.equal(view?.decision, '最近判定：窗口运行中（不探测） · 1 分钟前');
});

test('账号窗口状态：关窗待续 / 无活跃窗口待补 / 观察不到四种态各有说法', () => {
  const now = 1_800_000_000_000;
  const base = {
    anchorAtMs: 0,
    closeAtMs: 0,
    windowMinutes: 300,
    remainingMs: 0,
    source: 'snapshot',
    observedAtMs: now - 60 * 1000,
    nextActionAtMs: now,
    probeFailureCount: 0,
    lastDecision: { action: '', reason: '', at: 0 }
  };
  const closed = describeWindowActivationWindow({ window: { ...base, kind: 'closed' }, nowMs: now });
  assert.equal(closed?.label, '窗口已关闭');
  assert.match(String(closed?.text), /等待续窗/);

  const absent = describeWindowActivationWindow({ window: { ...base, kind: 'absent' }, nowMs: now });
  assert.equal(absent?.label, '没有活跃窗口');
  assert.match(String(absent?.text), /补一次极小探测/);

  const unknown = describeWindowActivationWindow({ window: { ...base, kind: 'unknown' }, nowMs: now });
  assert.equal(unknown?.label, '窗口状态未知');
  assert.match(String(unknown?.text), /兜底间隔/);
  // 没有判定记录时不显示「最近判定」
  assert.equal(unknown?.decision, '');
});

test('账号窗口状态：服务端没下发窗口状态时不渲染这一行', () => {
  assert.equal(describeWindowActivationWindow({}), null);
  assert.equal(describeWindowActivationWindow({ window: null }), null);
});

test('账号窗口状态：判定早于本次打开弹窗（旧账）时不显示，避免误导', () => {
  const now = 1_800_000_000_000;
  const view = describeWindowActivationWindow({
    window: {
      kind: 'open',
      anchorAtMs: 0,
      closeAtMs: now + 60 * 1000,
      windowMinutes: 300,
      remainingMs: 60 * 1000,
      source: 'probe',
      observedAtMs: 0,
      nextActionAtMs: 0,
      probeFailureCount: 0,
      lastDecision: { action: 'skip', reason: 'window_open', at: now - 3 * 24 * 60 * 60 * 1000 }
    },
    decisionSinceMs: now - 60 * 1000,
    nowMs: now
  });
  assert.equal(view?.decision, '');
  // 未知原因码原样透出，不掩盖调度器给出的原因
  const unknownReason = describeWindowActivationWindow({
    window: {
      kind: 'open',
      anchorAtMs: 0,
      closeAtMs: now + 60 * 1000,
      windowMinutes: 300,
      remainingMs: 60 * 1000,
      source: 'probe',
      observedAtMs: 0,
      nextActionAtMs: 0,
      probeFailureCount: 0,
      lastDecision: { action: 'skip', reason: 'brand_new_reason', at: now }
    },
    nowMs: now
  });
  assert.equal(unknownReason?.decision, '最近判定：brand_new_reason');
});

test('探测结果码：打到账号但上游报错时不冒充成功', () => {
  assert.equal(
    describeWindowActivationOutcome('matched_upstream_error'),
    '打到了该账号，但上游返回错误（不计为激活）'
  );
});
