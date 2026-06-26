const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadSessionWatchState() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'session-watch-state.js'
  )).href;
  return import(modulePath);
}

test('session watch update marks pending only for active turn events', async () => {
  const { resolveSessionWatchUpdateAction } = await loadSessionWatchState();

  assert.deepEqual(resolveSessionWatchUpdateAction({
    type: 'update',
    eventType: 'session:turn-started',
    phase: 'turn-started'
  }), {
    reload: true,
    markPending: true,
    clearPending: false
  });

  assert.deepEqual(resolveSessionWatchUpdateAction({
    type: 'update',
    eventType: 'session:file-changed',
    phase: 'file-changed'
  }), {
    reload: true,
    markPending: true,
    clearPending: false
  });
});

test('session watch stop hook clears pending instead of starting a spinner', async () => {
  const { resolveSessionWatchUpdateAction } = await loadSessionWatchState();

  assert.deepEqual(resolveSessionWatchUpdateAction({
    type: 'update',
    eventType: 'session:turn-completed',
    eventName: 'Stop',
    phase: 'turn-completed'
  }), {
    reload: true,
    markPending: false,
    clearPending: true
  });

  assert.deepEqual(resolveSessionWatchUpdateAction({
    type: 'update',
    eventType: 'session:closed',
    phase: 'session-closed'
  }), {
    reload: true,
    markPending: false,
    clearPending: true
  });
});

test('session watch passive updates reload without pending', async () => {
  const { resolveSessionWatchUpdateAction } = await loadSessionWatchState();

  assert.deepEqual(resolveSessionWatchUpdateAction({
    type: 'connected'
  }), {
    reload: false,
    markPending: false,
    clearPending: false
  });

  assert.deepEqual(resolveSessionWatchUpdateAction({
    type: 'update',
    eventType: 'session:opened',
    phase: 'session-opened'
  }), {
    reload: true,
    markPending: false,
    clearPending: false
  });
});
