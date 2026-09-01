'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildApiProxyMessages,
  __private: privateExports
} = require('../lib/server/webui-chat-routes-opencode-proxy');

test('buildApiProxyMessages auto-compacts oversized message history for small context models', () => {
  // Create a long conversation with large message contents
  const longText = 'A'.repeat(50000); // ~16.6k tokens each
  const messages = [
    { role: 'user', content: 'First message: ' + longText },
    { role: 'assistant', content: 'First response: ' + longText },
    { role: 'user', content: 'Second message: ' + longText },
    { role: 'assistant', content: 'Second response: ' + longText },
    { role: 'user', content: 'Latest prompt: Draw Doraemon with bamboo-copter' }
  ];

  // gemini-3.1-flash-image has a 65536 token limit
  const compacted = buildApiProxyMessages(messages, [], {
    model: 'gemini-3.1-flash-image',
    provider: 'agy'
  });

  assert.ok(compacted.length < messages.length, 'Should have compacted messages');
  assert.ok(compacted.length >= 1, 'Should retain at least the latest user message');
  const lastMsg = compacted[compacted.length - 1];
  assert.equal(lastMsg.role, 'user');
  assert.equal(lastMsg.content, 'Latest prompt: Draw Doraemon with bamboo-copter');
});

test('buildApiProxyMessages leaves normal size conversations untouched', () => {
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there! How can I help?' },
    { role: 'user', content: 'Draw a cat' }
  ];

  const result = buildApiProxyMessages(messages, [], {
    model: 'gemini-3.1-flash-image',
    provider: 'agy'
  });

  assert.equal(result.length, 3);
  assert.equal(result[0].content, 'Hello');
  assert.equal(result[2].content, 'Draw a cat');
});

test('buildApiProxyMessages 合并相邻且 content 完全相同的连续 user 消息', () => {
  const messages = [
    { role: 'user', content: '举杯邀明月' },
    { role: 'user', content: '举杯邀明月' },
    { role: 'assistant', content: '对影成三人' }
  ];

  const result = buildApiProxyMessages(messages, [], {
    model: 'gpt-5',
    provider: 'codex'
  });

  assert.deepEqual(result, [
    { role: 'user', content: '举杯邀明月' },
    { role: 'assistant', content: '对影成三人' }
  ]);
});

test('buildApiProxyMessages 保留被 assistant 隔开的有意重复 user 消息', () => {
  const messages = [
    { role: 'user', content: '再来一遍' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '再来一遍' }
  ];

  const result = buildApiProxyMessages(messages, [], {
    model: 'gpt-5',
    provider: 'codex'
  });

  assert.equal(result.length, 3);
  assert.equal(result[2].content, '再来一遍');
});

test('buildApiProxyMessages 保留相邻但 content 不同的连续 user 消息', () => {
  const messages = [
    { role: 'user', content: '举杯邀明月' },
    { role: 'user', content: '对影成三人' }
  ];

  const result = buildApiProxyMessages(messages, [], {
    model: 'gpt-5',
    provider: 'codex'
  });

  assert.equal(result.length, 2);
});

test('buildApiProxyMessages compacts at the 60% high-water mark', () => {
  // gemini-3.1-flash-image: context 65536 → 60% 高水位 ≈ 39321 tokens。
  // 两条 60k 字符消息 ≈ 40012 tokens(~61%),旧 75% 阈值(49152)不会压缩,60% 必须压缩。
  const bigText = 'B'.repeat(60000);
  const messages = [
    { role: 'user', content: bigText },
    { role: 'assistant', content: bigText },
    { role: 'user', content: 'latest question' }
  ];

  const compacted = buildApiProxyMessages(messages, [], {
    model: 'gemini-3.1-flash-image',
    provider: 'agy'
  });

  assert.ok(compacted.length < messages.length, '超过 60% 高水位必须自动压缩');
  assert.equal(compacted[compacted.length - 1].content, 'latest question');
});
