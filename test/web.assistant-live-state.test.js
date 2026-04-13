const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadAssistantLiveState() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'assistant-live-state.js'
  )).href;
  return import(modulePath);
}

test('appendAssistantThinking only mounts onto an existing pending assistant during snapshot event replay', async () => {
  const { appendAssistantThinking } = await loadAssistantLiveState();

  const untouched = appendAssistantThinking([
    { role: 'user', content: '继续', timestamp: 1 }
  ], '先分析一下', {
    createIfMissing: false,
    statusText: 'Codex 正在思考...',
    timestamp: 2
  });

  assert.deepEqual(untouched, [
    { role: 'user', content: '继续', timestamp: 1 }
  ]);

  const appended = appendAssistantThinking([
    { role: 'assistant', content: '', pending: true, timestamp: 3 }
  ], '先分析一下', {
    createIfMissing: false,
    statusText: 'Codex 正在思考...',
    timestamp: 4
  });

  assert.deepEqual(appended, [
    {
      role: 'assistant',
      content: ':::thinking\n先分析一下\n:::\n',
      pending: true,
      statusText: 'Codex 正在思考...',
      timestamp: 3
    }
  ]);
});

test('appendAssistantDelta strips transient thinking markup before writing visible answer text', async () => {
  const { appendAssistantDelta } = await loadAssistantLiveState();

  const appended = appendAssistantDelta([
    {
      role: 'assistant',
      content: ':::thinking\n先分析一下\n:::\n',
      pending: true,
      statusText: 'Codex 正在思考...',
      timestamp: 1
    }
  ], '正式回复', {
    statusText: '正在生成回复...',
    timestamp: 2
  });

  assert.deepEqual(appended, [
    {
      role: 'assistant',
      content: '正式回复',
      pending: true,
      statusText: '正在生成回复...',
      timestamp: 1
    }
  ]);
});

test('appendAssistantToolContent dedupes repeated tool summaries while preserving running state', async () => {
  const { appendAssistantToolContent } = await loadAssistantLiveState();

  const once = appendAssistantToolContent([
    { role: 'assistant', content: 'Read foo.ts', pending: true, timestamp: 1 }
  ], 'Read foo.ts', {
    pending: true,
    statusText: '正在处理...',
    timestamp: 2
  });

  assert.deepEqual(once, [
    {
      role: 'assistant',
      content: 'Read foo.ts',
      pending: true,
      statusText: '正在处理...',
      timestamp: 1
    }
  ]);
});

test('finalizeAssistantMessage and clearPendingAssistant close the current assistant in place', async () => {
  const { finalizeAssistantMessage, clearPendingAssistant } = await loadAssistantLiveState();

  const finalized = finalizeAssistantMessage([
    { role: 'assistant', content: '中间态', pending: true, statusText: '正在生成回复...', timestamp: 1 }
  ], '最终回复', { timestamp: 2 });

  assert.deepEqual(finalized, [
    { role: 'assistant', content: '最终回复', pending: false, statusText: undefined, timestamp: 1 }
  ]);

  const cleared = clearPendingAssistant([
    { role: 'assistant', content: '最终回复', pending: true, statusText: '正在生成回复...', timestamp: 3 }
  ], { timestamp: 4 });

  assert.deepEqual(cleared, [
    { role: 'assistant', content: '最终回复', pending: false, statusText: undefined, timestamp: 3 }
  ]);
});
