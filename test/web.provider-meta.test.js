const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadProviderMeta() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'provider-meta.js'
  )).href;
  return import(modulePath);
}

test('provider meta returns stable labels and tag colors for archived session UI', async () => {
  const { getProviderLabel, getProviderTagColor } = await loadProviderMeta();

  assert.equal(getProviderLabel('codex'), 'ChatGPT');
  assert.equal(getProviderLabel('claude'), 'Claude');
  assert.equal(getProviderLabel('gemini'), 'Gemini');
  assert.equal(getProviderTagColor('codex'), 'green');
  assert.equal(getProviderTagColor('claude'), 'orange');
  assert.equal(getProviderTagColor('gemini'), 'blue');
});
