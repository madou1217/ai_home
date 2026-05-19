const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadProjectRuntimeState() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'project-runtime-state.js'
  )).href;
  return import(modulePath);
}

test('getSessionRunKey keeps provider, session id and projectDirName stable', async () => {
  const { getSessionRunKey } = await loadProjectRuntimeState();

  assert.equal(getSessionRunKey({
    provider: 'codex',
    id: 'session-1',
    projectDirName: 'ai-home'
  }), 'codex:session-1:ai-home');
});

test('getRunningProviders only marks providers that have running sessions in the project', async () => {
  const { getRunningProviders } = await loadProjectRuntimeState();

  const providers = getRunningProviders([
    { provider: 'codex', id: 's1', projectDirName: 'p1' },
    { provider: 'gemini', id: 's2', projectDirName: 'p1' },
    { provider: 'claude', id: 's3', projectDirName: 'p1' }
  ], new Set(['codex:s1:p1', 'claude:s3:p1']));

  assert.deepEqual([...providers].sort(), ['claude', 'codex']);
});

test('isSessionRunning tolerates projectDirName mismatch as long as provider and session id still match', async () => {
  const { isSessionRunning } = await loadProjectRuntimeState();

  assert.equal(
    isSessionRunning(
      { provider: 'codex', id: 's1' },
      new Set(['codex:s1:ai_home'])
    ),
    true
  );

  assert.equal(
    isSessionRunning(
      { provider: 'codex', id: 's1', projectDirName: 'other-project' },
      new Set(['codex:s1:ai_home'])
    ),
    true
  );

  assert.equal(
    isSessionRunning(
      { provider: 'claude', id: 's1' },
      new Set(['codex:s1:ai_home'])
    ),
    false
  );
});

test('getRunningProviders uses the same fallback matching for session rows without projectDirName', async () => {
  const { getRunningProviders } = await loadProjectRuntimeState();

  const providers = getRunningProviders([
    { provider: 'codex', id: 's1' },
    { provider: 'gemini', id: 's2' }
  ], new Set(['codex:s1:ai_home']));

  assert.deepEqual([...providers], ['codex']);
});

test('getVisibleProjectSessions respects collapsed and expanded limits', async () => {
  const { getVisibleProjectSessions } = await loadProjectRuntimeState();

  const sessions = Array.from({ length: 18 }, (_, index) => ({
    provider: 'codex',
    id: `s${index + 1}`,
    projectDirName: 'p1'
  }));

  assert.equal(getVisibleProjectSessions(sessions, false, false).length, 0);
  assert.equal(getVisibleProjectSessions(sessions, true, false, 10, 15).length, 10);
  assert.equal(getVisibleProjectSessions(sessions, true, true, 10, 15).length, 15);
});

test('getProjectProviderBadges only spins running provider icons while the project is collapsed', async () => {
  const { getProjectProviderBadges } = await loadProjectRuntimeState();

  assert.deepEqual(
    getProjectProviderBadges(['codex', 'claude', 'gemini'], new Set(['codex', 'gemini']), false),
    [
      { provider: 'codex', spinning: true },
      { provider: 'claude', spinning: false },
      { provider: 'gemini', spinning: true }
    ]
  );

  assert.deepEqual(
    getProjectProviderBadges(['codex', 'claude'], new Set(['codex']), true),
    [
      { provider: 'codex', spinning: false },
      { provider: 'claude', spinning: false }
    ]
  );
});
