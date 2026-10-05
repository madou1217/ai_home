const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const loadPolicy = () => import(pathToFileURL(path.join(
  __dirname, '../web/src/components/chat/session-provider-policy.js'
)).href);

test('native session provider compatibility follows shared regions in both directions', async () => {
  const { areNativeSessionProvidersCompatible } = await loadPolicy();
  const regions = { codebuddy: 'global', workbuddy: 'global', codebuddycn: 'cn', workbuddycn: 'cn' };
  for (const [left, leftRegion] of Object.entries(regions)) {
    for (const [right, rightRegion] of Object.entries(regions)) {
      assert.equal(areNativeSessionProvidersCompatible(left, right), leftRegion === rightRegion);
    }
    assert.equal(areNativeSessionProvidersCompatible(left, 'codex'), false);
  }
  assert.equal(areNativeSessionProvidersCompatible('codex', 'codex'), true);
  assert.equal(areNativeSessionProvidersCompatible('', ''), false);
});

test('shared native session policy never relaxes canonical or account-owned sessions', async () => {
  const { isSharedNativeSession, isSessionAccountProviderCompatible } = await loadPolicy();
  const native = { id: 'native-id', provider: 'codebuddycn', projectPath: '/repo' };
  assert.equal(isSharedNativeSession(native), true);
  assert.equal(isSessionAccountProviderCompatible(native, 'workbuddycn'), true);
  assert.equal(isSessionAccountProviderCompatible(native, 'workbuddy'), false);
  for (const overrides of [
    { mode: 'chat' }, { runtimeSessionId: 'canonical-id' }, { accountRef: 'owner' },
    { draft: true }, { projectPath: '' },
  ]) {
    const session = { ...native, ...overrides };
    assert.equal(isSharedNativeSession(session), false);
    assert.equal(isSessionAccountProviderCompatible(session, 'workbuddycn'), false);
    assert.equal(isSessionAccountProviderCompatible(session, 'codebuddycn'), true);
  }
});
