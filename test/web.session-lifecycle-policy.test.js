const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadPolicy() {
  return import(pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'session-lifecycle-policy.js'
  )).href);
}

test('archive action is visible only for a complete native workflow', async () => {
  const { resolveArchiveAction } = await loadPolicy();
  const capabilities = {
    codex: {
      workflowAvailable: true,
      operations: {
        archive: { support: 'native', available: true }
      }
    },
    opencode: {
      workflowAvailable: false,
      reason: 'native_unarchive_unavailable',
      operations: {
        archive: { support: 'unsupported', available: false }
      }
    }
  };

  assert.deepEqual(resolveArchiveAction(capabilities, 'codex'), {
    visible: true,
    disabled: false,
    reason: ''
  });
  assert.deepEqual(resolveArchiveAction(capabilities, 'opencode'), {
    visible: false,
    disabled: true,
    reason: 'native_unarchive_unavailable'
  });
  assert.deepEqual(resolveArchiveAction(capabilities, 'claude'), {
    visible: false,
    disabled: true,
    reason: 'native_archive_unsupported'
  });
});

test('archive action stays visible but disabled when the native runtime is temporarily unavailable', async () => {
  const { resolveArchiveAction } = await loadPolicy();
  const capabilities = {
    codex: {
      workflowAvailable: false,
      reason: 'provider_runtime_not_found',
      operations: {
        archive: { support: 'native', available: false, reason: 'provider_runtime_not_found' }
      }
    }
  };

  assert.deepEqual(resolveArchiveAction(capabilities, 'codex'), {
    visible: true,
    disabled: true,
    reason: 'provider_runtime_not_found'
  });
});

test('archived session restore follows the server-provided reversible capability', async () => {
  const { canUnarchiveSession, archivedSessionTime } = await loadPolicy();

  assert.equal(canUnarchiveSession({ origin: 'native', canUnarchive: true }), true);
  assert.equal(canUnarchiveSession({ origin: 'native', canUnarchive: false }), false);
  assert.equal(canUnarchiveSession({ origin: 'legacy', canUnarchive: true }), true);
  assert.equal(archivedSessionTime({ archivedAt: 200, updatedAt: 100 }), 200);
  assert.equal(archivedSessionTime({ updatedAt: 100 }), 100);
});
