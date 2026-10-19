'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildApiProxyMessages,
  __private: privateExports
} = require('../lib/server/webui-chat-routes-opencode-proxy');
const { createModelsDevReader } = require('../lib/server/models-dev-metadata');

// 阈值来自 models.dev 快照，测试按同一份元数据换算消息规模：快照更新时
// 用例仍验证「60% 高水位」行为，而不是把某个模型的窗口大小钉死。
function catalogContextLimit(model, provider) {
  const entry = createModelsDevReader().resolveEntry({ id: model, provider });
  const limits = entry && entry.limits ? entry.limits : {};
  return limits.context || limits.input;
}

test('buildApiProxyMessages auto-compacts oversized message history for small context models', () => {
  const provider = 'agy';
  const model = 'gemini-3.1-flash-image';
  // 每条约 0.4 个上下文窗口，四条合计约 1.6 倍窗口，必然超过 60% 高水位。
  const longText = 'A'.repeat(Math.ceil(catalogContextLimit(model, provider) * 0.4 * 3));
  const messages = [
    { role: 'user', content: 'First message: ' + longText },
    { role: 'assistant', content: 'First response: ' + longText },
    { role: 'user', content: 'Second message: ' + longText },
    { role: 'assistant', content: 'Second response: ' + longText },
    { role: 'user', content: 'Latest prompt: Draw Doraemon with bamboo-copter' }
  ];

  const compacted = buildApiProxyMessages(messages, [], { model, provider });

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
  const provider = 'agy';
  const model = 'gemini-3.1-flash-image';
  // 总输入约 0.65 个窗口：高于 60% 高水位、低于旧的 75% 阈值，
  // 因此只有 60% 规则命中时才会压缩（阈值随 models.dev 元数据动态换算）。
  const bigText = 'B'.repeat(Math.ceil((catalogContextLimit(model, provider) * 0.65 / 2) * 3));
  const messages = [
    { role: 'user', content: bigText },
    { role: 'assistant', content: bigText },
    { role: 'user', content: 'latest question' }
  ];

  const compacted = buildApiProxyMessages(messages, [], { model, provider });

  assert.ok(compacted.length < messages.length, '超过 60% 高水位必须自动压缩');
  assert.equal(compacted[compacted.length - 1].content, 'latest question');
});
