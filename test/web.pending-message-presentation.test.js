const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadPendingMessagePresentation() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'pending-message-presentation.js'
  )).href;
  return import(modulePath);
}

test('pending message presentation ignores pure thinking blocks so the pending shell stays compact', async () => {
  const { getRenderablePendingBlocks, hasRenderablePendingBlocks } = await loadPendingMessagePresentation();

  const blocks = [
    { type: 'thinking', value: '先分析一下约束' }
  ];

  assert.deepEqual(getRenderablePendingBlocks(blocks), []);
  assert.equal(hasRenderablePendingBlocks(blocks), false);
});

test('pending message presentation preserves tool and text blocks for live detail rendering', async () => {
  const { getRenderablePendingBlocks, hasRenderablePendingBlocks } = await loadPendingMessagePresentation();

  const blocks = [
    { type: 'thinking', value: '先分析一下约束' },
    { type: 'tool_use', name: 'Read', body: '/tmp/foo.ts' },
    { type: 'text', value: '正在检查实现' }
  ];

  assert.deepEqual(getRenderablePendingBlocks(blocks), [
    { type: 'tool_use', name: 'Read', body: '/tmp/foo.ts' },
    { type: 'text', value: '正在检查实现' }
  ]);
  assert.equal(hasRenderablePendingBlocks(blocks), true);
});
