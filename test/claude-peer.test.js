'use strict';

// Claude 跨会话消息帧的纯函数部分：信封格式与帧结构。
// 协议取证见 docs/providers/claude-cross-session-protocol.md。

const test = require('node:test');
const assert = require('node:assert/strict');

const { envelope, buildFrames, findByTarget } = require('../scripts/claude-peer');

test('envelope：属性顺序固定为 from → from-name → from-mode', () => {
  const text = envelope('hello', {
    fromAddress: 'uds:%2Ftmp%2Fcc-socks%2F1.sock',
    fromName: 'lab-peer',
    mode: 'bypass'
  });
  assert.equal(
    text,
    '<cross-session-message from="uds:%2Ftmp%2Fcc-socks%2F1.sock" from-name="lab-peer" from-mode="bypass">\nhello\n</cross-session-message>'
  );
});

test('envelope：没有属性时退化成裸标签，正文里的引号不参与转义', () => {
  assert.equal(envelope('a "b" c'), '<cross-session-message>\na "b" c\n</cross-session-message>');
});

test('envelope：from-name 里的引号/尖括号被丢掉（否则收件方解析不了）', () => {
  const text = envelope('x', { fromName: 'bad"<name>' });
  assert.match(text, /from-name="badname"/);
});

test('buildFrames：auth 行 + 一条 type=user 的帧，msg_id 是 cc-msg- 前缀', () => {
  const peer = { pid: 1234, socket: '/tmp/cc-socks/1234.sock' };
  const frames = buildFrames(peer, 'hi', {
    mode: 'bypass',
    token: '0123456789abcdef0123456789abcdef'
  });

  const auth = JSON.parse(frames.auth);
  assert.equal(auth.type, 'auth');
  assert.match(auth.token, /^[0-9a-f]{32}$/);

  const frame = JSON.parse(frames.control);
  assert.equal(frame.msgV, 1);
  assert.match(frame.msg_id, /^cc-msg-[0-9a-f]{32}$/);
  assert.equal(frame.type, 'user');
  assert.equal(frame.message.role, 'user');
  assert.equal(frame.priority, 'next');
  assert.match(frame.message.content, /^<cross-session-message from-mode="bypass">/);
});

test('findByTarget：pid / name / sessionId 都能定位，找不到返回 null', () => {
  const peers = [
    { pid: 11, name: 'alpha', sessionId: 'sid-a' },
    { pid: 22, name: 'beta', sessionId: 'sid-b' }
  ];
  assert.equal(findByTarget(peers, '22').name, 'beta');
  assert.equal(findByTarget(peers, 'alpha').pid, 11);
  assert.equal(findByTarget(peers, 'sid-b').pid, 22);
  assert.equal(findByTarget(peers, 'nope'), null);
  assert.equal(findByTarget(peers, ''), null);
});
