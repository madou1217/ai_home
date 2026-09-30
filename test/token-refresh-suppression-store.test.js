'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TokenRefreshSuppressionStore,
  STORE_FILE_NAME
} = require('../lib/server/token-refresh-suppression-store');

function createStore(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-token-refresh-suppression-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return { aiHomeDir, store: new TokenRefreshSuppressionStore({ fs, path, aiHomeDir }) };
}

test('load returns an empty list when the store does not exist', (t) => {
  const { store } = createStore(t);
  assert.deepEqual(store.load(), []);
  assert.equal(store.filePath, path.join(path.dirname(store.filePath), STORE_FILE_NAME));
});

test('save then load round-trips suppression entries', (t) => {
  const { store } = createStore(t);
  store.save([
    { accountRef: 'acct_aaa', signature: '12:deadbeef', retryAt: 1_700_000_000_000 },
    { accountRef: 'acct_bbb', signature: '9:cafebabe', retryAt: 1_700_000_100_000 }
  ]);

  assert.deepEqual(store.load(), [
    { accountRef: 'acct_aaa', signature: '12:deadbeef', retryAt: 1_700_000_000_000 },
    { accountRef: 'acct_bbb', signature: '9:cafebabe', retryAt: 1_700_000_100_000 }
  ]);

  // Round-trips again after a fresh store instance, i.e. across a restart.
  const reopened = new TokenRefreshSuppressionStore({ fs, path, aiHomeDir: path.dirname(path.dirname(store.filePath)) });
  assert.equal(reopened.load().length, 2);
});

test('load never throws on a corrupt or malformed store', (t) => {
  const { store } = createStore(t);
  fs.mkdirSync(path.dirname(store.filePath), { recursive: true });

  fs.writeFileSync(store.filePath, 'not json at all');
  assert.deepEqual(store.load(), []);

  fs.writeFileSync(store.filePath, JSON.stringify({ version: 1, entries: 'nope' }));
  assert.deepEqual(store.load(), []);

  fs.writeFileSync(store.filePath, JSON.stringify({ version: 1, entries: [null, 7, 'x'] }));
  assert.deepEqual(store.load(), []);
});

test('load drops entries that are missing required fields', (t) => {
  const { store } = createStore(t);
  fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
  fs.writeFileSync(store.filePath, JSON.stringify({
    version: 1,
    entries: [
      { accountRef: 'acct_ok', signature: 'sig', retryAt: 123 },
      { accountRef: '', signature: 'sig', retryAt: 123 },
      { accountRef: 'acct_no_sig', signature: '', retryAt: 123 },
      { accountRef: 'acct_no_retry', signature: 'sig' },
      { accountRef: 'acct_bad_retry', signature: 'sig', retryAt: 'later' }
    ]
  }));

  assert.deepEqual(store.load(), [
    { accountRef: 'acct_ok', signature: 'sig', retryAt: 123 }
  ]);
});

test('save is best-effort and never throws when the write fails', (t) => {
  const { aiHomeDir } = createStore(t);
  const failingFs = new Proxy(fs, {
    get(target, prop) {
      if (prop === 'writeFileSync') {
        return () => {
          const error = new Error('EACCES: permission denied');
          error.code = 'EACCES';
          throw error;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  const store = new TokenRefreshSuppressionStore({ fs: failingFs, path, aiHomeDir });
  assert.doesNotThrow(() => store.save([
    { accountRef: 'acct_aaa', signature: 'sig', retryAt: 123 }
  ]));
});
