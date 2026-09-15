'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCapabilityCommandCatalog } = require('../lib/server/chat-runtime/capability-command-catalog');

test('branch commands follow driver capability without using a provider name or stale snapshot', () => {
  const catalog = createCapabilityCommandCatalog();
  const branches = (session, driver) => catalog.list(session, driver)
    .filter((entry) => ['session.fork', 'turn.regenerate'].includes(entry.type)).map((entry) => entry.type);
  assert.deepEqual(branches({ provider: 'codex', policy: {} }), []);
  assert.deepEqual(branches({ provider: 'future', policy: {} }, { historyBranch: true }), ['session.fork', 'turn.regenerate']);
  assert.deepEqual(branches({ policy: { workspaceMode: 'chat' } }), ['session.fork', 'turn.regenerate']);
});
