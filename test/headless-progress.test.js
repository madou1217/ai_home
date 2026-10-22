'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const {
  createHeadlessProgress
} = require('../lib/cli/services/pty/headless-progress');

function createProcessStub({ isTTY = true, env = {}, platform = 'darwin' } = {}) {
  const errorWrites = [];
  const stderr = new EventEmitter();
  stderr.write = (chunk) => { errorWrites.push(String(chunk || '')); };
  if (isTTY) stderr.isTTY = true;
  return { processObj: { stderr, env, platform }, errorWrites };
}

function createClock(startMs = 1000) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => { current += ms; }
  };
}

test('TTY 下画 spinner，首字节后换成耗时并收掉动画', () => {
  const { processObj, errorWrites } = createProcessStub();
  const clock = createClock();
  const progress = createHeadlessProgress({ processObj, label: 'Running claude', now: clock.now });

  progress.start();
  assert.equal(progress.isAnimated(), true);
  assert.equal(errorWrites.length, 1);
  assert.match(errorWrites[0], /⠋/);
  assert.match(errorWrites[0], /Running claude/);
  assert.match(errorWrites[0], /0\.0s/);

  clock.advance(3200);
  progress.markFirstOutput();
  const rendered = errorWrites.join('');
  assert.match(rendered, /首字节 3\.2s/);
  // The spinner line is erased before the summary lands.
  assert.match(rendered, /\r\x1b\[K/);
  assert.equal(rendered.endsWith('\n'), true);
});

test('非 TTY 时不写任何动画字节', () => {
  const { processObj, errorWrites } = createProcessStub({ isTTY: false });
  const progress = createHeadlessProgress({ processObj, label: 'Running claude' });

  progress.start();
  progress.markFirstOutput();
  progress.stop();

  assert.equal(progress.isAnimated(), false);
  assert.equal(errorWrites.join(''), '');
});

test('没有任何输出就结束时，用一行收尾而不是把整行擦空', () => {
  const { processObj, errorWrites } = createProcessStub();
  const clock = createClock();
  const progress = createHeadlessProgress({ processObj, label: 'Running claude', now: clock.now });

  progress.start();
  clock.advance(3500);
  progress.stop();

  const rendered = errorWrites.join('');
  assert.match(rendered, /无输出 3\.5s/);
  assert.equal(rendered.includes('首字节'), false);
  // Must end on a fresh line, or the shell prompt lands on the cleared row.
  assert.equal(rendered.endsWith('\n'), true);
});

test('markFirstOutput 只生效一次，stop 之后也不再写', () => {
  const { processObj, errorWrites } = createProcessStub();
  const progress = createHeadlessProgress({ processObj, label: 'Running claude' });

  progress.start();
  progress.markFirstOutput();
  const afterFirst = errorWrites.length;
  progress.markFirstOutput();
  progress.stop();

  assert.equal(errorWrites.length, afterFirst);
});

test('Windows 回退到 ASCII 帧', () => {
  const { processObj, errorWrites } = createProcessStub({ platform: 'win32' });
  const progress = createHeadlessProgress({ processObj, label: 'Running claude' });

  progress.start();
  assert.match(errorWrites[0], /\|/);
  assert.equal(/[⠋⠙⠹]/.test(errorWrites[0]), false);
  progress.stop();
});

test('finish 用 ✔/✖ 收尾并带耗时与附注，而不是「首字节」/「无输出」', () => {
  const { processObj, errorWrites } = createProcessStub();
  const clock = createClock();
  const ok = createHeadlessProgress({ processObj, label: '安装 dsh-tui', now: clock.now });

  ok.start();
  clock.advance(18400);
  ok.finish({ ok: true, note: '已安装' });
  const rendered = errorWrites.join('');
  assert.match(rendered, /✔/);
  assert.match(rendered, /已安装 18\.4s/);
  assert.equal(rendered.includes('首字节'), false);
  assert.equal(rendered.includes('无输出'), false);
  assert.equal(rendered.endsWith('\n'), true);

  const { processObj: failing, errorWrites: failedWrites } = createProcessStub();
  const fail = createHeadlessProgress({ processObj: failing, label: '安装 dsh-tui' });
  fail.start();
  fail.finish({ ok: false, note: '安装失败' });
  const failed = failedWrites.join('');
  assert.match(failed, /✖/);
  assert.match(failed, /安装失败/);
});

test('finish 与其它收尾方式一样只生效一次，非 TTY 不写字节', () => {
  const { processObj, errorWrites } = createProcessStub();
  const progress = createHeadlessProgress({ processObj, label: '安装 dsh-tui' });
  progress.start();
  progress.finish({ ok: true });
  const afterFinish = errorWrites.length;
  progress.finish({ ok: false });
  progress.markFirstOutput();
  progress.stop();
  assert.equal(errorWrites.length, afterFinish);

  const { processObj: quiet, errorWrites: quietWrites } = createProcessStub({ isTTY: false });
  const plain = createHeadlessProgress({ processObj: quiet, label: '安装 dsh-tui' });
  plain.start();
  plain.finish({ ok: true, note: '已安装' });
  assert.equal(quietWrites.join(''), '');
});
