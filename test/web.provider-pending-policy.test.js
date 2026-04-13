const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadProviderPendingPolicy() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'provider-pending-policy.js'
  )).href;
  return import(modulePath);
}

test('provider pending policy exposes provider-aware thinking text and external pending behavior', async () => {
  const {
    getThinkingStatusText,
    getProcessingStatusText,
    getGeneratingStatusText,
    shouldUseExternalPending,
    normalizePendingStatusText
  } = await loadProviderPendingPolicy();

  assert.equal(getThinkingStatusText('codex'), 'Codex 正在思考...');
  assert.equal(getThinkingStatusText('claude'), '正在思考...');
  assert.equal(getProcessingStatusText(), '正在处理...');
  assert.equal(getGeneratingStatusText(), '正在生成回复...');
  assert.equal(shouldUseExternalPending('codex'), true);
  assert.equal(shouldUseExternalPending('claude'), false);
  assert.equal(normalizePendingStatusText('Codex 正在思考...', 'codex'), '正在思考中');
  assert.equal(normalizePendingStatusText('正在思考...', 'claude'), '正在思考中');
  assert.equal(normalizePendingStatusText('正在处理...', 'claude'), '正在处理');
});
