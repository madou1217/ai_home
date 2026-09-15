'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the real response adapter with isolated storage dependencies.
// No real auth files, network, App process, or require.cache mutation.
function loadAdapter(options = {}) {
  const calls = { config: 0, identity: 0, account: 0 };
  const filename = path.join(__dirname, '../lib/server/codex-app-server-stdio-proxy-patch.js');
  const moduleObject = { exports: {} };
  const dependencies = {
    'node:path': path,
    '../sessions/codex-visible-session-policy': {},
    './codex-desktop-account': {
      resolveCodexDesktopChatGptIdentity() {
        calls.identity += 1;
        if (options.throwOnLookup) throw new Error('old_identity_must_not_be_consulted');
        return options.missingIdentity ? null : { accessToken: 'test-old-managed-token' };
      },
      resolveCodexDesktopChatGptAccount() {
        calls.account += 1;
        return { type: 'chatgpt', email: 'test-old@example.invalid', planType: 'unknown' };
      }
    },
    './codex-app-server-stdio-proxy-utils': {
      tryParseJson(line) {
        try { return JSON.parse(line); } catch (_) { return null; }
      },
      resolveCodexStateHome() { return '/test-only/codex-home'; },
      readCurrentCodexRuntimeConfig() {
        calls.config += 1;
        if (options.throwOnLookup) throw new Error('old_config_must_not_be_consulted');
        return { modelProvider: options.provider || 'aih_server' };
      },
      isAihManagedProvider(value) { return value === 'aih_server'; }
    }
  };
  const localRequire = (id) => {
    if (!Object.hasOwn(dependencies, id)) throw new Error(`unexpected_dependency:${id}`);
    return dependencies[id];
  };
  const wrapper = new vm.Script(`(function(require, module, exports) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  wrapper.runInThisContext()(localRequire, moduleObject, moduleObject.exports);
  return { ...moduleObject.exports, calls };
}

function response(result) {
  // Whitespace and unrelated fields make byte-preserving pass-through observable.
  return JSON.stringify({ id: 'test-auth-status', result, extra: 'keep' }, null, 2);
}

function expectNativePassThrough(result, context = {}) {
  const adapter = loadAdapter({ throwOnLookup: true });
  const line = response(result);
  assert.equal(adapter.patchAuthStatusResponse(line, context, { fs: {} }), line);
  assert.deepEqual(adapter.calls, { config: 0, identity: 0, account: 0 });
}

test('fresh native ChatGPT auth is authoritative regardless of old managed identity', () => {
  expectNativePassThrough({ authMethod: 'chatgpt', authToken: 'test-new-native-token', requiresOpenaiAuth: false });
});

test('fresh native auth needs no matching old account or workspace', () => {
  expectNativePassThrough({ authMethod: 'chatgpt', authToken: 'test-unrelated-native-token', requiresOpenaiAuth: false, workspace: 'test-unrelated-workspace' });
});

test('native token-redacted responses do not get a stored token inserted', () => {
  expectNativePassThrough({ authMethod: 'chatgpt', authToken: null, requiresOpenaiAuth: false }, { includeToken: false });
});

test('native ChatGPT mode with an omitted token still forbids old-identity fallback', () => {
  expectNativePassThrough({ authMethod: 'chatgpt', requiresOpenaiAuth: false });
});

test('requiresOpenaiAuth=true is preserved rather than forced to false', () => {
  expectNativePassThrough({ authMethod: null, authToken: null, requiresOpenaiAuth: true });
});

test('a refresh request does not authorize replacing native auth with an old snapshot', () => {
  expectNativePassThrough({ authMethod: 'chatgpt', authToken: null, requiresOpenaiAuth: true }, { refreshToken: true });
});

test('API-key response with requiresOpenaiAuth=true cannot use the legacy gateway fallback', () => {
  expectNativePassThrough({ authMethod: 'apikey', authToken: null, requiresOpenaiAuth: true });
});

test('unknown auth modes pass through without guessing their semantics', () => {
  expectNativePassThrough({ authMethod: 'test-future-auth-mode', authToken: 'test-native', requiresOpenaiAuth: false });
});

test('an absent requiresOpenaiAuth is not treated as explicit false', () => {
  expectNativePassThrough({ authMethod: 'apikey', authToken: 'test-native' });
});

test('a token with no declared method is not overwritten by a guessed managed identity', () => {
  expectNativePassThrough({ authMethod: null, authToken: 'test-native', requiresOpenaiAuth: false });
});

for (const result of [[], {}, 'test-value', null]) {
  test(`non-status result passes through: ${JSON.stringify(result)}`, () => {
    expectNativePassThrough(result);
  });
}

test('malformed JSON and JSON-RPC errors pass through without auth lookup', () => {
  const adapter = loadAdapter({ throwOnLookup: true });
  for (const line of ['not json', JSON.stringify({ id: 1, error: { code: -1 }, result: { requiresOpenaiAuth: false } })]) {
    assert.equal(adapter.patchAuthStatusResponse(line, {}, { fs: {} }), line);
  }
  assert.deepEqual(adapter.calls, { config: 0, identity: 0, account: 0 });
});

for (const authMethod of ['apikey', null]) {
  test(`legacy gateway fallback remains available for its explicit response shape: ${authMethod}`, () => {
    const adapter = loadAdapter();
    const line = response({ authMethod, authToken: null, requiresOpenaiAuth: false });
    const result = JSON.parse(adapter.patchAuthStatusResponse(line, {}, { fs: {} }));
    assert.equal(result.result.authMethod, 'chatgpt');
    assert.equal(result.result.authToken, 'test-old-managed-token');
    assert.equal(result.extra, 'keep');
    assert.deepEqual(adapter.calls, { config: 1, identity: 1, account: 0 });
  });
}

test('legacy gateway fallback still respects includeToken=false', () => {
  const adapter = loadAdapter();
  const line = response({ authMethod: 'apikey', authToken: 'test-gateway-token', requiresOpenaiAuth: false });
  const result = JSON.parse(adapter.patchAuthStatusResponse(line, { includeToken: false }, { fs: {} }));
  assert.equal(result.result.authMethod, 'chatgpt');
  assert.equal(result.result.authToken, null);
});

test('an unmanaged runtime does not use the managed fallback', () => {
  const adapter = loadAdapter({ provider: 'openai' });
  const line = response({ authMethod: null, authToken: null, requiresOpenaiAuth: false });
  assert.equal(adapter.patchAuthStatusResponse(line, {}, { fs: {} }), line);
  assert.equal(adapter.calls.identity, 0);
});

test('missing managed credentials cannot fabricate an authenticated response', () => {
  const adapter = loadAdapter({ missingIdentity: true });
  const line = response({ authMethod: 'apikey', authToken: null, requiresOpenaiAuth: false });
  assert.equal(adapter.patchAuthStatusResponse(line, {}, { fs: {} }), line);
});

test('account/read continues to preserve the actual native account', () => {
  const adapter = loadAdapter({ throwOnLookup: true });
  const line = response({ account: { type: 'chatgpt', email: 'test-new@example.invalid' }, requiresOpenaiAuth: false });
  assert.equal(adapter.patchAccountReadResponse(line, { fs: {} }), line);
  assert.deepEqual(adapter.calls, { config: 0, identity: 0, account: 0 });
});
