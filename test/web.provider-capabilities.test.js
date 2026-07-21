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

test('provider capabilities expose retry pending without leaking codex runtime behaviors', async () => {
  const {
    supportsExternalPending,
    supportsIncrementalSessionEvents,
    supportsSessionWatchPending,
    supportsBackgroundRunWatch,
    supportsToolBoundaryQueue,
    resolveQueueMode
  } = await loadProviderCapabilities();

  assert.equal(supportsExternalPending('codex'), true);
  assert.equal(supportsExternalPending('claude'), true);
  assert.equal(supportsExternalPending('opencode'), true);
  assert.equal(supportsExternalPending('gemini'), false);
  assert.equal(supportsSessionWatchPending('codex'), true);
  assert.equal(supportsSessionWatchPending('claude'), false);
  assert.equal(supportsSessionWatchPending('opencode'), false);
  assert.equal(supportsBackgroundRunWatch('codex'), true);
  assert.equal(supportsBackgroundRunWatch('claude'), false);
  assert.equal(supportsBackgroundRunWatch('gemini'), false);
  assert.equal(supportsIncrementalSessionEvents('codex'), true);
  assert.equal(supportsIncrementalSessionEvents('agy'), false);
  assert.equal(supportsIncrementalSessionEvents('claude'), false);

  assert.equal(supportsToolBoundaryQueue('codex', false), true);
  assert.equal(supportsToolBoundaryQueue('codex', true), false);
  assert.equal(supportsToolBoundaryQueue('claude', false), false);

  assert.equal(resolveQueueMode('codex', false), 'after_tool_call');
  assert.equal(resolveQueueMode('codex', true), 'after_turn');
  assert.equal(resolveQueueMode('gemini', false), 'after_turn');
});
