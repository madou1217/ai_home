'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const {
  ANIMATION_ENV_KEY,
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

test('AIH_HEADLESS_SPINNER=0 关掉动画', () => {
  const { processObj, errorWrites } = createProcessStub({ env: { [ANIMATION_ENV_KEY]: '0' } });
  const progress = createHeadlessProgress({ processObj, label: 'Running claude' });

  progress.start();
  progress.markFirstOutput();

  assert.equal(progress.isAnimated(), false);
  assert.equal(errorWrites.join(''), '');
});

test('没有任何输出就结束时，擦掉半截 spinner 且不报耗时', () => {
  const { processObj, errorWrites } = createProcessStub();
  const progress = createHeadlessProgress({ processObj, label: 'Running claude' });

  progress.start();
  progress.stop();

  const rendered = errorWrites.join('');
  assert.equal(rendered.endsWith('\r\x1b[K'), true);
  assert.equal(rendered.includes('首字节'), false);
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
