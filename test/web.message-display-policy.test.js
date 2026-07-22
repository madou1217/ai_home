const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadMessageDisplayPolicy() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'message-display-policy.js'
  )).href;
  return import(modulePath);
}

test('completed empty assistant messages are hidden', async () => {
  const { filterRenderableChatMessages } = await loadMessageDisplayPolicy();
  const messages = filterRenderableChatMessages([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: '', pending: false },
    { role: 'assistant', content: 'answer', pending: false }
  ]);

  assert.deepEqual(messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'answer', pending: false }
  ]);
});

test('pending or image-only assistant messages remain renderable', async () => {
  const { filterRenderableChatMessages } = await loadMessageDisplayPolicy();
  const pending = { role: 'assistant', content: '', pending: true };
  const imageOnly = { role: 'assistant', content: '', pending: false, images: ['data:image/png;base64,AA=='] };

  assert.deepEqual(filterRenderableChatMessages([pending, imageOnly]), [pending, imageOnly]);
});
