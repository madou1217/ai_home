'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTerminalInputFramer } = require('../lib/cli/services/pty/terminal-input-framer');

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const received = [];
  const framer = createTerminalInputFramer({ onData: (data) => received.push(data), ...options });
  t.after(() => framer.reset());
  return { ...framer, received };
}

test('fragmented device replies, mouse events and extended keys reach the child as complete frames', (t) => {
  const f = fixture(t);
  for (const value of ['\x1b[?62c', '\x1b[>0;276;0c', '\x1b[<64;67;30M', '\x1b[<0;12;9m',
    '\x1b[A', '\x1b[106;7u', '\x1b[27;7;106~', '\x1b[?2026;1$y']) {
    for (let cut = 1; cut < value.length; cut += 1) {
      f.received.length = 0;
      f.push(Buffer.from(value.slice(0, cut)));
      t.mock.timers.tick(cut === 1 ? 10 : 1000);
      assert.deepEqual(f.received, []);
      f.push(Buffer.from(value.slice(cut)));
      assert.deepEqual(f.received, [Buffer.from(value)]);
    }
  }
});

test('ordinary input, UTF8 bytes, Alt shortcuts and complete protocol frames stay byte-identical', (t) => {
  const f = fixture(t);
  for (const value of ['你好🙂', '?62c', '<64;67;30M', '\x03', '\x1b\n', '\x1bOP',
    '\x1b]52;c;YWJj\x07', 'hello\x1b[A世界']) {
    f.received.length = 0;
    f.push(Buffer.from(value));
    assert.deepEqual(f.received, [Buffer.from(value)]);
  }
  f.received.length = 0;
  f.push('\x1b[');
  f.push(Buffer.from('A中文'));
  assert.deepEqual(f.received, ['\x1b[A中文']);
});

test('literal escape sequences inside a fragmented bracketed paste are preserved', (t) => {
  const f = fixture(t);
  const chunks = ['\x1b[200~粘贴\x1b[', '?62c\x1b[<64;67;30M', '\x1b[20', '1~'];
  for (const chunk of chunks) f.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(f.received).toString('utf8'), chunks.join(''));
  f.received.length = 0;
  f.push('\x1b[');
  assert.deepEqual(f.received, []);
  f.push('A');
  assert.deepEqual(f.received, ['\x1b[A']);
});

test('standalone Escape remains usable and truncated input has bounded waiting', (t) => {
  const f = fixture(t);
  f.push('\x1b');
  t.mock.timers.tick(30);
  assert.deepEqual(f.received, ['\x1b']);
  f.push('\x1b[?');
  t.mock.timers.tick(2000);
  assert.deepEqual(f.received, ['\x1b', '\x1b[?']);
  f.push('text');
  assert.equal(f.received.at(-1), 'text');
});

test('reset discards pending input from the previous runtime and cancels delayed delivery', (t) => {
  const f = fixture(t);
  f.push('\x1b[');
  f.reset();
  t.mock.timers.tick(3000);
  f.push('next');
  assert.deepEqual(f.received, ['next']);
});

test('a timed-out paste terminator cannot disable framing for the rest of the session', (t) => {
  const f = fixture(t);
  f.push('\x1b[200~hello\x1b[20');
  t.mock.timers.tick(2000);
  f.push('1~');
  assert.equal(f.received.join(''), '\x1b[200~hello\x1b[201~');
  f.received.length = 0;
  f.push('\x1b[');
  assert.deepEqual(f.received, []);
  f.push('?62c');
  assert.deepEqual(f.received, ['\x1b[?62c']);
});

test('unbounded and interrupted control sequences do not swallow input or Ctrl-C', (t) => {
  const f = fixture(t, { maxSequenceBytes: 16 });
  const input = '\x1b[' + '?'.repeat(20);
  f.push(input);
  assert.deepEqual(f.received, [input]);
  f.push('\x1b[');
  f.push('\x03');
  assert.equal(f.received.at(-1), '\x1b[\x03');
});
