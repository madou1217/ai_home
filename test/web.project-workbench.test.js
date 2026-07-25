const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule(fileName) {
  return import(pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'features',
    'project-workbench',
    fileName
  )).href);
}

function tab(kind, id, overrides = {}) {
  return {
    id,
    kind,
    label: kind,
    closable: kind !== 'chat',
    ...(kind === 'browser' ? { url: 'http://127.0.0.1:9527' } : {}),
    ...overrides,
  };
}

test('workbench reducer enforces singleton and bounded panel policies', async () => {
  const {
    createInitialWorkbenchState,
    reduceWorkbenchState,
  } = await loadModule('workbench-state-policy.js');
  let state = createInitialWorkbenchState();
  state = reduceWorkbenchState(state, {
    type: 'tab/add',
    tab: tab('review', 'review-1'),
  });
  state = reduceWorkbenchState(state, {
    type: 'tab/add',
    tab: tab('review', 'review-2'),
  });
  assert.deepEqual(state.tabs.map(({ id }) => id), ['wb-chat-0', 'review-1']);
  assert.equal(state.activeTabId, 'review-1');

  for (let index = 1; index <= 5; index += 1) {
    state = reduceWorkbenchState(state, {
      type: 'tab/add',
      tab: tab('terminal', `terminal-${index}`),
    });
  }
  assert.equal(state.tabs.filter(({ kind }) => kind === 'terminal').length, 4);
  assert.equal(state.activeTabId, 'terminal-1');
});

test('workbench reducer preserves valid state for close and reorder edge cases', async () => {
  const {
    createInitialWorkbenchState,
    reduceWorkbenchState,
  } = await loadModule('workbench-state-policy.js');
  const initial = createInitialWorkbenchState();
  const withBrowser = reduceWorkbenchState(initial, {
    type: 'tab/add',
    tab: tab('browser', 'browser-1'),
  });
  assert.equal(
    reduceWorkbenchState(withBrowser, {
      type: 'tab/reorder',
      fromIndex: 9,
      toIndex: 0,
    }),
    withBrowser
  );
  const closed = reduceWorkbenchState(withBrowser, {
    type: 'tab/close',
    id: 'browser-1',
  });
  assert.deepEqual(closed.tabs.map(({ id }) => id), ['wb-chat-0']);
  assert.equal(closed.activeTabId, 'wb-chat-0');
  assert.equal(
    reduceWorkbenchState(closed, { type: 'tab/close', id: 'wb-chat-0' }),
    closed
  );
});

test('workbench persistence restores supported panels and legacy active chat safely', async () => {
  const {
    restoreWorkbenchState,
    serializeWorkbenchState,
    workbenchProjectStorageKey,
  } = await loadModule('workbench-persistence-policy.js');
  const state = {
    tabs: [
      tab('chat', 'wb-chat-0'),
      tab('terminal', 'terminal-1'),
      tab('files', 'files-1', { filePath: '/repo/src/index.ts' }),
      tab('browser', 'browser-1', { url: 'https://example.test' }),
      tab('review', 'review-1'),
    ],
    activeTabId: 'browser-1',
  };
  const restored = restoreWorkbenchState(JSON.parse(serializeWorkbenchState(state)));

  assert.deepEqual(restored.tabs.map(({ kind }) => kind), [
    'chat',
    'files',
    'browser',
    'review',
  ]);
  assert.equal(
    restored.tabs.find(({ id }) => id === restored.activeTabId).kind,
    'browser'
  );
  assert.equal(
    restored.tabs.find(({ kind }) => kind === 'files').filePath,
    '/repo/src/index.ts'
  );
  assert.equal(
    restored.tabs.find(({ kind }) => kind === 'browser').url,
    'https://example.test'
  );

  const legacy = restoreWorkbenchState({
    v: 2,
    tabs: [{ kind: 'side-chat', label: '旧会话' }],
    activeKind: 'side-chat',
  });
  assert.deepEqual(legacy.tabs.map(({ kind }) => kind), ['chat']);
  assert.equal(legacy.activeTabId, 'wb-chat-0');
  assert.equal(
    workbenchProjectStorageKey('/repo'),
    workbenchProjectStorageKey('/repo')
  );
  assert.notEqual(
    workbenchProjectStorageKey('/repo'),
    workbenchProjectStorageKey('/other')
  );
});
