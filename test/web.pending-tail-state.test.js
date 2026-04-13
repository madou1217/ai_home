const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadPendingTailState() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'pending-tail-state.js'
  )).href;
  return import(modulePath);
}

test('pending tail becomes visible when the session is pending but no assistant anchor exists yet', async () => {
  const { resolvePendingTailState } = await loadPendingTailState();

  const result = resolvePendingTailState({
    messages: [
      { role: 'user', content: '没有看到 web thinking 效果' }
    ],
    loading: false,
    externalPending: true,
    externalPendingStatusText: 'Codex 正在思考...',
    activeProvider: 'codex'
  });

  assert.deepEqual(result, {
    visible: true,
    statusText: 'Codex 正在思考...'
  });
});

test('pending tail stays hidden once a real pending assistant message already exists', async () => {
  const { resolvePendingTailState } = await loadPendingTailState();

  const result = resolvePendingTailState({
    messages: [
      { role: 'user', content: '继续' },
      { role: 'assistant', content: '', pending: true }
    ],
    loading: true,
    activeProvider: 'codex'
  });

  assert.deepEqual(result, {
    visible: false,
    statusText: ''
  });
});
