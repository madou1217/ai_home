'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

async function loadHydrationHelpers() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'services',
    'project-session-hydration.js'
  )).href;
  return import(modulePath);
}

function createSession(id, updatedAt, patch = {}) {
  return {
    id,
    title: `session-${id}`,
    provider: 'codex',
    updatedAt,
    ...patch
  };
}

function createProject(sessions, sessionTotal = sessions.length) {
  return {
    id: 'project-ai-home',
    name: 'ai_home',
    path: '/projects/ai_home',
    providers: ['codex'],
    sessions,
    sessionTotal
  };
}

test('partial projects and deep links missing from a compact snapshot require hydration', async () => {
  const { shouldHydrateProjectSessions } = await loadHydrationHelpers();
  const partial = createProject([createSession('recent', 2)], 2);
  const complete = createProject([createSession('recent', 2)], 1);

  assert.equal(shouldHydrateProjectSessions(partial), true);
  assert.equal(shouldHydrateProjectSessions(complete), false);
  assert.equal(shouldHydrateProjectSessions(complete, { sessionId: 'older', provider: 'codex' }), true);
});

test('a compact SSE snapshot refreshes recent metadata without dropping hydrated sessions', async () => {
  const { mergeHydratedProjectSessions } = await loadHydrationHelpers();
  const hydrated = createProject([
    createSession('older', 1),
    createSession('recent', 2, { title: 'old title' })
  ]);
  const compactSnapshot = createProject([
    createSession('recent', 3, { title: 'latest title', preview: 'new preview' })
  ], 2);

  const merged = mergeHydratedProjectSessions(compactSnapshot, hydrated);

  assert.deepEqual(merged.sessions.map((session) => session.id), ['recent', 'older']);
  assert.equal(merged.sessions[0].title, 'latest title');
  assert.equal(merged.sessions[0].preview, 'new preview');
  assert.equal(merged.sessionTotal, 2);
});

test('a later compact snapshot preserves every hydrated project independently', async () => {
  const { preserveHydratedProjectSessions } = await loadHydrationHelpers();
  const hydrated = new Map([
    ['/projects/ai_home', createProject([
      createSession('older', 1),
      createSession('recent', 2)
    ])]
  ]);
  const compact = [createProject([createSession('recent', 3)], 2)];

  const [merged] = preserveHydratedProjectSessions(compact, hydrated);

  assert.deepEqual(merged.sessions.map((session) => session.id), ['recent', 'older']);
});

test('a project total decrease marks hydration stale while retaining the full tail during refresh', async () => {
  const {
    isHydratedProjectSessionsStale,
    mergeHydratedProjectSessions
  } = await loadHydrationHelpers();
  const hydrated = createProject([
    createSession('oldest', 1),
    createSession('middle', 2),
    createSession('recent', 3)
  ], 3);
  const compactSnapshot = createProject([
    createSession('recent', 4)
  ], 2);

  const merged = mergeHydratedProjectSessions(compactSnapshot, hydrated);

  assert.equal(isHydratedProjectSessionsStale(compactSnapshot, hydrated), true);
  assert.deepEqual(merged.sessions.map((session) => session.id), ['recent', 'middle', 'oldest']);
  assert.equal(merged.sessions.length, 3);
  assert.equal(merged.sessionTotal, 2);
});

test('a compact snapshot with an unknown recent identity marks hydration stale', async () => {
  const { isHydratedProjectSessionsStale } = await loadHydrationHelpers();
  const hydrated = createProject([
    createSession('older', 1),
    createSession('recent', 2)
  ], 2);
  const compactSnapshot = createProject([
    createSession('new', 3)
  ], 2);

  assert.equal(isHydratedProjectSessionsStale(compactSnapshot, hydrated), true);
  assert.equal(
    isHydratedProjectSessionsStale(
      createProject([createSession('recent', 4, { title: 'metadata changed' })], 2),
      hydrated
    ),
    false,
    'metadata-only changes must not trigger a full reload'
  );
});

test('an already complete compact snapshot replaces hydrated state directly', async () => {
  const { mergeHydratedProjectSessions } = await loadHydrationHelpers();
  const hydrated = createProject([
    createSession('removed', 1),
    createSession('recent', 2)
  ], 2);
  const completeSnapshot = createProject([createSession('recent', 3)], 1);

  const merged = mergeHydratedProjectSessions(completeSnapshot, hydrated);

  assert.deepEqual(merged.sessions.map((session) => session.id), ['recent']);
});

test('a completed hydration response owns membership while retaining latest compact metadata', async () => {
  const { applyProjectSessionHydrationResponse } = await loadHydrationHelpers();
  const staleCurrent = createProject([
    createSession('removed', 4),
    createSession('recent', 5, { title: 'latest title' })
  ], 1);
  const response = createProject([
    createSession('recent', 3, { title: 'response title' })
  ], 1);

  const merged = applyProjectSessionHydrationResponse(staleCurrent, response);

  assert.deepEqual(merged.sessions.map((session) => session.id), ['recent']);
  assert.equal(merged.sessions[0].title, 'latest title');
});

test('stale requests cannot overwrite a newer request, server, or removed project', async () => {
  const { canApplyProjectSessionHydration } = await loadHydrationHelpers();
  const valid = {
    requestId: 4,
    latestRequestId: 4,
    serverKey: 'aws',
    currentServerKey: 'aws',
    projectPath: '/projects/ai_home',
    responseProjectPath: '/projects/ai_home',
    currentProjectPaths: new Set(['/projects/ai_home'])
  };

  assert.equal(canApplyProjectSessionHydration(valid), true);
  assert.equal(canApplyProjectSessionHydration({ ...valid, latestRequestId: 5 }), false);
  assert.equal(canApplyProjectSessionHydration({ ...valid, currentServerKey: 'local' }), false);
  assert.equal(canApplyProjectSessionHydration({ ...valid, currentProjectPaths: new Set() }), false);
  assert.equal(canApplyProjectSessionHydration({ ...valid, responseProjectPath: '/projects/other' }), false);
});
