'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const POLLER_FILE = path.join(
  __dirname,
  '..',
  'web',
  'src',
  'features',
  'accounts',
  'app-entry-poller.ts'
);

function loadPollerModule() {
  assert.equal(
    fs.existsSync(POLLER_FILE),
    true,
    '账号页需要独立的 Desktop 运行态轮询器'
  );
  const ts = require('../web/node_modules/typescript');
  const source = fs.readFileSync(POLLER_FILE, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  }).outputText;
  const loaded = { exports: {} };
  Function('module', 'exports', 'require', output)(loaded, loaded.exports, require);
  return loaded.exports;
}

function createEventTarget(initialVisibility = 'visible') {
  const listeners = new Map();
  return {
    visibilityState: initialVisibility,
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
    dispatch(name) {
      const listener = listeners.get(name);
      if (listener) listener();
    },
    hasListener(name) {
      return listeners.has(name);
    }
  };
}

function createWindowTarget() {
  const events = createEventTarget();
  let intervalHandler = null;
  let cleared = false;
  return {
    ...events,
    setInterval(handler) {
      intervalHandler = handler;
      return 17;
    },
    clearInterval(id) {
      assert.equal(id, 17);
      cleared = true;
    },
    tick() {
      assert.equal(typeof intervalHandler, 'function');
      intervalHandler();
    },
    wasCleared() {
      return cleared;
    }
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

test('账号页轮询在 Desktop 外部退出后应用空运行态', async () => {
  const { startAccountAppEntryPolling } = loadPollerModule();
  const windowTarget = createWindowTarget();
  const documentTarget = createEventTarget();
  let runningAccounts = ['acct_0123456789abcdef0123'];
  const applied = [];

  const stop = startAccountAppEntryPolling({
    request: async () => ({ runningAccounts: [...runningAccounts] }),
    onResult: (result) => applied.push(result.runningAccounts),
    windowTarget,
    documentTarget,
    intervalMs: 10
  });
  await flushPromises();
  assert.deepEqual(applied, [['acct_0123456789abcdef0123']]);

  runningAccounts = [];
  windowTarget.tick();
  await flushPromises();
  assert.deepEqual(applied, [['acct_0123456789abcdef0123'], []]);

  stop();
  assert.equal(windowTarget.wasCleared(), true);
});

test('账号页轮询在后台暂停并在恢复可见时立即刷新', async () => {
  const { startAccountAppEntryPolling } = loadPollerModule();
  const windowTarget = createWindowTarget();
  const documentTarget = createEventTarget('hidden');
  let requests = 0;

  const stop = startAccountAppEntryPolling({
    request: async () => {
      requests += 1;
      return { runningAccounts: [] };
    },
    onResult: () => {},
    windowTarget,
    documentTarget,
    intervalMs: 10
  });
  await flushPromises();
  assert.equal(requests, 0);

  documentTarget.visibilityState = 'visible';
  documentTarget.dispatch('visibilitychange');
  await flushPromises();
  assert.equal(requests, 1);

  stop();
  assert.equal(windowTarget.hasListener('focus'), false);
  assert.equal(documentTarget.hasListener('visibilitychange'), false);
});

test('Accounts 页面接入运行态轮询器而不是只在挂载时读取一次', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'pages', 'Accounts.tsx'), 'utf8');
  assert.match(source, /startAccountAppEntryPolling\s*\(\s*\{/);
  assert.match(source, /request:\s*\(\)\s*=>\s*accountsAPI\.listAppEntries\(\)/);
  assert.match(source, /onResult:\s*applyAppEntries/);
});
