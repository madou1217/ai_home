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

async function loadWebProviderCatalog() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'provider-catalog.js'
  )).href;
  return import(modulePath);
}

test('provider meta returns stable labels and tag colors for archived session UI', async () => {
  const { getProviderLabel, getProviderTagColor } = await loadProviderMeta();

  assert.equal(getProviderLabel('codex'), 'ChatGPT');
  assert.equal(getProviderLabel('claude'), 'Claude');
  assert.equal(getProviderLabel('gemini'), 'Gemini');
  assert.equal(getProviderLabel('agy'), 'Antigravity');
  assert.equal(getProviderLabel('opencode'), 'OpenCode');
  assert.equal(getProviderTagColor('codex'), 'green');
  assert.equal(getProviderTagColor('claude'), 'orange');
  assert.equal(getProviderTagColor('gemini'), 'blue');
  assert.equal(getProviderTagColor('agy'), 'purple');
  assert.equal(getProviderTagColor('opencode'), 'default');
});

test('provider catalog keeps server and web provider ids aligned', async () => {
  const sharedCatalog = require('../lib/provider-catalog');
  const { SUPPORTED_SERVER_PROVIDERS } = require('../lib/server/providers');
  const { providerIds, providerNames, getProviderTerminalBadge, getProviderTerminalIconAsset } = await loadWebProviderCatalog();

  assert.deepEqual(providerIds, sharedCatalog.listProviderIds());
  assert.deepEqual(SUPPORTED_SERVER_PROVIDERS, sharedCatalog.listProviderIds());
  assert.equal(providerNames.opencode, 'OpenCode');
  assert.equal(sharedCatalog.getProviderTerminalIconAsset('claude'), 'assets/provider-icons/claude.png');
  assert.equal(getProviderTerminalIconAsset('codex'), 'assets/provider-icons/codex.png');
  assert.equal(sharedCatalog.getProviderTerminalBadge('codex'), '◎ GPT');
  assert.equal(getProviderTerminalBadge('gemini'), '✦ GM');
});
