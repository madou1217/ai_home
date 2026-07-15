const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadProviderCapabilities() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'provider-capabilities.js'
  )).href;
  return import(modulePath);
}

test('provider capabilities keep codex oauth specific behaviors isolated from other providers', async () => {
  const {
    supportsExternalPending,
    supportsSessionWatchPending,
    supportsBackgroundRunWatch,
    supportsToolBoundaryQueue,
    resolveQueueMode
  } = await loadProviderCapabilities();

  assert.equal(supportsExternalPending('codex'), true);
  assert.equal(supportsExternalPending('claude'), false);
  assert.equal(supportsExternalPending('gemini'), false);
  assert.equal(supportsSessionWatchPending('codex'), true);
  assert.equal(supportsSessionWatchPending('claude'), false);
  assert.equal(supportsBackgroundRunWatch('codex'), true);
  assert.equal(supportsBackgroundRunWatch('gemini'), false);

  assert.equal(supportsToolBoundaryQueue('codex', false), true);
  assert.equal(supportsToolBoundaryQueue('codex', true), false);
  assert.equal(supportsToolBoundaryQueue('claude', false), false);

  assert.equal(resolveQueueMode('codex', false), 'after_tool_call');
  assert.equal(resolveQueueMode('codex', true), 'after_turn');
  assert.equal(resolveQueueMode('gemini', false), 'after_turn');
});
