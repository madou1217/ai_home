const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadActiveRunState() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'active-run-state.js'
  )).href;
  return import(modulePath);
}

test('findActiveRunKeyForSession resolves draft and persisted sessions independently', async () => {
  const { findActiveRunKeyForSession } = await loadActiveRunState();

  const activeRuns = [
    {
      runKey: 'draft:draft-1',
      provider: 'codex',
      draftSessionId: 'draft-1'
    },
    {
      runKey: 'codex:session-1:proj-a',
      provider: 'codex',
      sessionId: 'session-1',
      projectDirName: 'proj-a'
    },
    {
      runKey: 'claude:session-9:',
      provider: 'claude',
      sessionId: 'session-9'
    }
  ];

  assert.equal(findActiveRunKeyForSession({
    id: 'draft-1',
    draft: true,
    provider: 'codex'
  }, activeRuns), 'draft:draft-1');

  assert.equal(findActiveRunKeyForSession({
    id: 'session-1',
    draft: false,
    provider: 'codex',
    projectDirName: 'proj-a'
  }, activeRuns), 'codex:session-1:proj-a');

  assert.equal(findActiveRunKeyForSession({
    id: 'session-9',
    draft: false,
    provider: 'claude'
  }, activeRuns), 'claude:session-9:');
});

test('collectRunningSessionKeys keeps multiple sessions running in parallel instead of collapsing to one', async () => {
  const { collectRunningSessionKeys } = await loadActiveRunState();

  const runningKeys = collectRunningSessionKeys([
    {
      runKey: 'codex:session-1:proj-a',
      provider: 'codex',
      sessionId: 'session-1',
      projectDirName: 'proj-a'
    },
    {
      runKey: 'gemini:session-2:proj-a',
      provider: 'gemini',
      sessionId: 'session-2',
      projectDirName: 'proj-a'
    },
    {
      runKey: 'draft:draft-3',
      provider: 'claude',
      draftSessionId: 'draft-3'
    }
  ]);

  assert.deepEqual([...runningKeys].sort(), [
    'codex:session-1:proj-a',
    'gemini:session-2:proj-a'
  ]);
});

test('resolveSelectedSessionQueueKey prefers the active run key and falls back to the session key', async () => {
  const { resolveSelectedSessionQueueKey } = await loadActiveRunState();

  assert.equal(resolveSelectedSessionQueueKey({
    id: 'session-1',
    draft: false,
    provider: 'codex',
    projectDirName: 'proj-a'
  }, 'codex:session-1:proj-a'), 'codex:session-1:proj-a');

  assert.equal(resolveSelectedSessionQueueKey({
    id: 'draft-1',
    draft: true,
    provider: 'codex'
  }, ''), 'draft:draft-1');
});
