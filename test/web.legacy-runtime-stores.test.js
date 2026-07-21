'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const webSrc = path.join(__dirname, '..', 'web', 'src');

async function loadStore(relativePath, aliases) {
  const sourcePath = path.join(webSrc, relativePath);
  let source = fs.readFileSync(sourcePath, 'utf8');
  for (const [specifier, target] of Object.entries(aliases)) {
    source = source.replaceAll(specifier, pathToFileURL(path.join(webSrc, target)).href);
  }
  source += `\n// test-instance:${Date.now()}:${Math.random()}`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function installWindow(t, sessionStorage) {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { sessionStorage }
  });
  t.after(() => {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, 'window', previousDescriptor);
    } else {
      delete globalThis.window;
    }
  });
}

function createSessionStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
}

test('legacy active run survives UI unsubscribe and remains explicitly abortable', async () => {
  const { legacyActiveRunStore } = await loadStore(
    'features/legacy-chat/legacy-active-run-store.js',
    {
      '@/components/chat/active-run-state.js': 'components/chat/active-run-state.js'
    }
  );
  const controller = new AbortController();
  let notifications = 0;
  const unsubscribe = legacyActiveRunStore.subscribe(() => { notifications += 1; });

  legacyActiveRunStore.register({
    runKey: 'codex:session-1:project-1',
    provider: 'codex',
    sessionId: 'session-1',
    projectDirName: 'project-1',
    projectPath: '/repo',
    controller
  });
  unsubscribe();

  assert.equal(notifications, 1);
  assert.equal(controller.signal.aborted, false);
  assert.equal(legacyActiveRunStore.activeRunsRef.current.size, 1);
  assert.deepEqual(
    [...legacyActiveRunStore.getSnapshot().runningSessionKeys],
    ['codex:session-1:project-1']
  );

  legacyActiveRunStore.activeRunsRef.current
    .get('codex:session-1:project-1')
    .controller.abort();
  assert.equal(controller.signal.aborted, true);
});

test('legacy queued messages are shifted and persisted without a mounted subscriber', async (t) => {
  const storage = createSessionStorage();
  installWindow(t, storage);
  const { legacyMessageQueueStore } = await loadStore(
    'features/legacy-chat/legacy-message-queue-store.js',
    {
      '@/components/chat/queue-state.js': 'components/chat/queue-state.js'
    }
  );
  const sessionKey = 'claude:session-1:project-1';
  const storageKey = `chat-queue:v1:${sessionKey}`;
  const unsubscribe = legacyMessageQueueStore.subscribe(() => {});
  legacyMessageQueueStore.enqueue(sessionKey, { id: 'q1', content: 'first' });
  legacyMessageQueueStore.enqueue(sessionKey, { id: 'q2', content: 'second' });
  unsubscribe();

  assert.deepEqual(legacyMessageQueueStore.shift(sessionKey), { id: 'q1', content: 'first' });
  assert.equal(storage.values.get(storageKey), JSON.stringify([{ id: 'q2', content: 'second' }]));

  let resumedNotifications = 0;
  const unsubscribeResumed = legacyMessageQueueStore.subscribe(() => {
    resumedNotifications += 1;
  });
  assert.deepEqual(legacyMessageQueueStore.getSnapshot()[sessionKey], [
    { id: 'q2', content: 'second' }
  ]);
  assert.deepEqual(legacyMessageQueueStore.shift(sessionKey), { id: 'q2', content: 'second' });
  assert.equal(resumedNotifications, 1);
  assert.equal(storage.values.has(storageKey), false);
  unsubscribeResumed();
});

test('legacy queue hydrates a persisted message for a new page instance', async (t) => {
  const sessionKey = 'claude:session-restore:project-1';
  const storage = createSessionStorage({
    [`chat-queue:v1:${sessionKey}`]: JSON.stringify([
      { id: 'q-restore', content: 'continue after navigation' }
    ])
  });
  installWindow(t, storage);
  const { legacyMessageQueueStore } = await loadStore(
    'features/legacy-chat/legacy-message-queue-store.js',
    {
      '@/components/chat/queue-state.js': 'components/chat/queue-state.js'
    }
  );

  legacyMessageQueueStore.ensureHydrated(sessionKey);

  assert.deepEqual(legacyMessageQueueStore.getSnapshot()[sessionKey], [
    { id: 'q-restore', content: 'continue after navigation' }
  ]);
});
