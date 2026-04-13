const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadLiveMessageState() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'live-message-state.js'
  )).href;
  return import(modulePath);
}

test('appendThinkingChunk keeps thinking content in the same block', async () => {
  const { appendThinkingChunk } = await loadLiveMessageState();

  const first = appendThinkingChunk('', '先分析问题');
  const second = appendThinkingChunk(first, '，再检查约束');

  assert.equal(second, ':::thinking\n先分析问题，再检查约束\n:::\n');
});

test('stripThinkingBlock removes transient thinking markup before final delta text is merged', async () => {
  const { stripThinkingBlock } = await loadLiveMessageState();

  const content = ':::thinking\n先分析问题\n:::\n\n正式回复';
  assert.equal(stripThinkingBlock(content), '正式回复');
});

test('decorateMessagesWithPendingState does not create a synthetic assistant message without a real anchor', async () => {
  const { decorateMessagesWithPendingState } = await loadLiveMessageState();

  const result = decorateMessagesWithPendingState({
    messages: [
      { role: 'user', content: '帮我继续处理这个任务', timestamp: 1 }
    ],
    loading: false,
    externalPending: true,
    externalPendingStatusText: 'Codex 正在思考...',
    activeProvider: 'codex',
    pendingTimestamp: 2
  });

  assert.equal(result.usedSyntheticPending, false);
  assert.equal(result.messages.length, 1);
  assert.deepEqual(result.messages[0], {
    role: 'user',
    content: '帮我继续处理这个任务',
    timestamp: 1
  });
});

test('decorateMessagesWithPendingState only decorates the last real assistant message', async () => {
  const { decorateMessagesWithPendingState } = await loadLiveMessageState();

  const result = decorateMessagesWithPendingState({
    messages: [
      { role: 'user', content: '先看看日志', timestamp: 1 },
      { role: 'assistant', content: '我先检查一下', timestamp: 2 }
    ],
    loading: true,
    loadingStatusText: '正在处理...',
    externalPending: false,
    activeProvider: 'codex',
    pendingTimestamp: 3
  });

  assert.equal(result.usedSyntheticPending, true);
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages[1], {
    role: 'assistant',
    content: '我先检查一下',
    pending: true,
    statusText: '正在处理...',
    timestamp: 2
  });
});
