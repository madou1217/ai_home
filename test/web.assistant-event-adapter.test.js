const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadAssistantEventAdapter() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'assistant-event-adapter.js'
  )).href;
  return import(modulePath);
}

test('applySessionAssistantEvent mounts reasoning only onto existing pending assistant messages', async () => {
  const { applySessionAssistantEvent } = await loadAssistantEventAdapter();

  const ignored = applySessionAssistantEvent([
    { role: 'user', content: '继续', timestamp: 1 }
  ], {
    type: 'assistant_reasoning',
    text: '先分析问题',
    timestamp: 't1'
  }, {
    thinkingStatusText: 'Codex 正在思考...'
  });

  assert.deepEqual(ignored, [
    { role: 'user', content: '继续', timestamp: 1 }
  ]);

  const attached = applySessionAssistantEvent([
    { role: 'assistant', content: '', pending: true, timestamp: 2 }
  ], {
    type: 'assistant_reasoning',
    text: '先分析问题',
    timestamp: 't2'
  }, {
    thinkingStatusText: 'Codex 正在思考...'
  });

  assert.deepEqual(attached, [
    {
      role: 'assistant',
      content: ':::thinking\n先分析问题\n:::\n',
      pending: true,
      statusText: 'Codex 正在思考...',
      timestamp: 2
    }
  ]);
});

test('applySessionAssistantEvent merges tool content and keeps pending status when the session is still running', async () => {
  const { applySessionAssistantEvent } = await loadAssistantEventAdapter();

  const merged = applySessionAssistantEvent([
    { role: 'assistant', content: 'Read foo.ts', pending: true, timestamp: 2 }
  ], {
    type: 'assistant_tool_result',
    content: 'Edited bar.ts',
    timestamp: 't3'
  }, {
    pending: true,
    processingStatusText: '正在处理...'
  });

  assert.deepEqual(merged, [
    {
      role: 'assistant',
      content: 'Read foo.ts\n\nEdited bar.ts',
      pending: true,
      statusText: '正在处理...',
      timestamp: 2
    }
  ]);
});

test('applyStreamingAssistantEvent normalizes thinking -> delta -> done into one assistant message', async () => {
  const { applyStreamingAssistantEvent } = await loadAssistantEventAdapter();

  let messages = applyStreamingAssistantEvent([], {
    type: 'thinking',
    thinking: '先分析问题'
  }, {
    timestamp: 1,
    thinkingStatusText: 'Codex 正在思考...'
  });

  messages = applyStreamingAssistantEvent(messages, {
    type: 'delta',
    delta: '最终回复'
  }, {
    timestamp: 2,
    generatingStatusText: '正在生成回复...'
  });

  messages = applyStreamingAssistantEvent(messages, {
    type: 'done'
  }, {
    timestamp: 3
  });

  assert.deepEqual(messages, [
    {
      role: 'assistant',
      content: '最终回复',
      pending: false,
      statusText: undefined,
      timestamp: 1
    }
  ]);
});

test('applyStreamingAssistantEvent keeps terminal-output attached to the current assistant shell', async () => {
  const { applyStreamingAssistantEvent } = await loadAssistantEventAdapter();

  const messages = applyStreamingAssistantEvent([
    { role: 'assistant', content: '正在执行命令:\n', pending: true, timestamp: 1 }
  ], {
    type: 'terminal-output',
    text: 'ls -la\n'
  }, {
    timestamp: 2,
    processingStatusText: '正在处理...'
  });

  assert.deepEqual(messages, [
    {
      role: 'assistant',
      content: '正在执行命令:\nls -la\n',
      pending: true,
      statusText: '正在处理...',
      timestamp: 1
    }
  ]);
});
