'use strict';

// 输入回显的**字节级**记忆：stdin 是任意切分的字节流，一个汉字的 UTF-8 编码可能
// 正好被切在两个 chunk 之间。逐块解码会把它变成 U+FFFD，回显比对就永远认不出
// 中文原文——用户粘一句中文 429 反而会被当成上游报错。这里守住「拼接后仍完整」。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MAX_BYTES,
  DEFAULT_WINDOW_MS,
  createUserInputEchoBuffer
} = require('../lib/cli/services/pty/user-input-echo');

const ZH_429 = '您的使用量已超出频率限制，将在 2026-11-04 13:34:21 UTC+8 重置。';

test('字符串输入按原文读回', () => {
  const buffer = createUserInputEchoBuffer();
  assert.equal(buffer.remember('429 Credits exhausted'), true);
  assert.equal(buffer.read(), '429 Credits exhausted');
});

test('汉字被切在两个 chunk 之间，拼起来仍然是完整的原文', () => {
  const buffer = createUserInputEchoBuffer();
  const bytes = Buffer.from(ZH_429, 'utf8');
  // 第 4 个字节落在第二个汉字的中间：任何「逐块解码」的实现都会在这里丢字。
  const splitAt = 4;
  const first = bytes.subarray(0, splitAt);
  const second = bytes.subarray(splitAt);
  assert.match(first.toString('utf8'), /\uFFFD/, '这个切点必须真的撕开一个汉字，否则测不到东西');

  buffer.remember(first);
  buffer.remember(second);
  assert.equal(buffer.read(), ZH_429);
});

test('Buffer 分块与字符串混用也保持顺序', () => {
  const buffer = createUserInputEchoBuffer();
  buffer.remember(Buffer.from('429 Cred', 'utf8'));
  buffer.remember('its exhausted');
  assert.equal(buffer.read(), '429 Credits exhausted');
});

test('时间窗过期后读不到（旧输入不能无限期压掉真实报错）', () => {
  let nowMs = 1_000_000;
  const buffer = createUserInputEchoBuffer({ windowMs: 5000, now: () => nowMs });
  buffer.remember('429 Credits exhausted');
  nowMs += 5001;
  assert.equal(buffer.read(), '');
  assert.equal(buffer.read(nowMs), '');
});

test('默认窗口两分钟、最多 16KB', () => {
  assert.equal(DEFAULT_WINDOW_MS, 2 * 60 * 1000);
  assert.equal(DEFAULT_MAX_BYTES, 16 * 1024);
});

test('只留最后 maxBytes 个字节，长粘贴不会无限增长', () => {
  const buffer = createUserInputEchoBuffer({ maxBytes: 8 });
  buffer.remember('abcdefghijkl');
  assert.equal(buffer.read(), 'efghijkl');
});

test('clear 之后什么都不留', () => {
  const buffer = createUserInputEchoBuffer();
  buffer.remember('429 Credits exhausted');
  buffer.clear();
  assert.equal(buffer.read(), '');
  assert.equal(buffer.remember(''), false);
});

test('空输入不进窗口，也不会刷新时间窗', () => {
  let nowMs = 1000;
  const buffer = createUserInputEchoBuffer({ windowMs: 100, now: () => nowMs });
  buffer.remember('429 Credits exhausted');
  nowMs += 90;
  buffer.remember('');
  buffer.remember(null);
  nowMs += 20;
  assert.equal(buffer.read(), '');
});
