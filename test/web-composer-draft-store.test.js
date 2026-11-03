'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../web/node_modules/typescript');

function loadStore(server = { serverId: 'local', isRemote: false }) {
  const source = fs.readFileSync(require.resolve('../web/src/features/chat-runtime/composer-draft-store.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const data = new Map();
  const localStorage = {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
  const moduleForTest = { exports: {} };
  const requireStub = (id) => {
    if (id === '@/services/webui-auth-transport') return { resolveActiveServer: () => server };
    throw new Error(`unexpected require ${id}`);
  };
  vm.runInNewContext(compiled, {
    module: moduleForTest, exports: moduleForTest.exports, require: requireStub,
    window: { localStorage }, Date,
  });
  return moduleForTest.exports;
}

test('switching account or provider inside one session keeps the draft', () => {
  const store = loadStore();
  // The identity no longer carries provider/account, so the same session reads the same slot.
  store.writeComposerDraft({ sessionId: 's1', projectPath: '/p' }, 'half typed');
  assert.equal(store.readComposerDraft({ sessionId: 's1', projectPath: '/p' }), 'half typed');
});

test('new-session drafts share one slot across provider-specific draft ids', () => {
  const store = loadStore();
  store.writeComposerDraft({ sessionId: 'draft-1', draft: true, projectPath: '/p' }, 'hello');
  assert.equal(
    store.readComposerDraft({ sessionId: 'draft-2', draft: true, projectPath: '/p' }),
    'hello',
  );
  // Different project is a different slot (chat has no projectPath).
  assert.equal(store.readComposerDraft({ sessionId: 'draft-3', draft: true, projectPath: '/q' }), '');
});

test('a cross-provider switch carries the typed text into the next session', () => {
  const store = loadStore();
  const chatSession = { sessionId: 'chat-abc' };
  store.writeComposerDraft(chatSession, 'move me');
  store.carryComposerDraftToNextSession();
  const next = { sessionId: 'draft-9', draft: true };
  assert.equal(store.readComposerDraft(next), 'move me');
  // Moved, not copied: the old session's slot is emptied and the carry is one-shot.
  assert.equal(store.readComposerDraft(chatSession), '');
  assert.equal(store.readComposerDraft(next), 'move me');
});

test('carry never overwrites a draft the target session already has', () => {
  const store = loadStore();
  store.writeComposerDraft({ sessionId: 'b' }, 'mine');
  store.writeComposerDraft({ sessionId: 'a' }, 'theirs');
  store.carryComposerDraftToNextSession();
  assert.equal(store.readComposerDraft({ sessionId: 'b' }), 'mine');
  assert.equal(store.readComposerDraft({ sessionId: 'a' }), 'theirs');
});

test('without a carry request, switching sessions does not leak drafts', () => {
  const store = loadStore();
  store.writeComposerDraft({ sessionId: 'a' }, 'only for a');
  assert.equal(store.readComposerDraft({ sessionId: 'b' }), '');
});

test('drafts are isolated per server', () => {
  const server = { serverId: 'aws', isRemote: true };
  const store = loadStore(server);
  store.writeComposerDraft({ sessionId: 's' }, 'on aws');
  server.serverId = 'mac';
  assert.equal(store.readComposerDraft({ sessionId: 's' }), '');
});
