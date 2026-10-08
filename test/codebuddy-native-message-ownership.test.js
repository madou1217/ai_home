'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveAccountRuntimeDir, resolveAccountCliRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const { __private: { readJsonlFromOffset } } = require('../lib/usage/model-usage-scanner');
const { createNativeMessageOwnership, parseNativeMessageWrites } = require('../lib/usage/codebuddy-native-message-ownership');

const AT = new Date(2026, 9, 7, 4, 15, 13, 390).getTime();
const FIRST = 'acct_aaaaaaaaaaaaaaaaaaaa', SECOND = 'acct_bbbbbbbbbbbbbbbbbbbb';
const DIRS = { codebuddy: '.codebuddy', codebuddycn: '.codebuddy-cn', workbuddy: '.workbuddy-ai', workbuddycn: '.workbuddy' };
const LINE = '[10/7/2026, 4:15:13 AM.391] [Info] [pid=76984] [addHistory] START sessionId=session, storeId=undefined, types=[message], input=[{type: message, id: answer}]';

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-family-writer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accounts = new Map([[FIRST, 'codebuddy'], [SECOND, 'workbuddy']]);
  const store = {};
  let bytesRead = 0;
  const instrumentedFs = Object.create(fs);
  instrumentedFs.readSync = (...args) => { const bytes = fs.readSync(...args); bytesRead += bytes; return bytes; };
  function log(ref = FIRST, { cli = false } = {}) {
    const provider = accounts.get(ref);
    const home = (cli ? resolveAccountCliRuntimeDir : resolveAccountRuntimeDir)(root, provider, ref);
    const file = path.join(home, DIRS[provider], 'logs', '2026-10-07', 'project.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return file;
  }
  const load = () => createNativeMessageOwnership({ fs: instrumentedFs, path, aiHomeDir: root, accounts, store, readJsonlFromOffset });
  const file = { provider: 'codebuddy', sessionId: 'session' };
  return { root, accounts, log, load, file, bytesRead: () => bytesRead };
}

test('native writer grammar accepts both observed local timestamps and rejects unrelated/invalid log text', () => {
  assert.deepEqual(parseNativeMessageWrites(LINE), [{ sessionId: 'session', messageId: 'answer', timestampMs: AT + 1 }]);
  assert.deepEqual(parseNativeMessageWrites(LINE.replace('[10/7/2026, 4:15:13 AM.391]', '[2026/10/7 04:15:13.391]')),
    [{ sessionId: 'session', messageId: 'answer', timestampMs: AT + 1 }]);
  for (const line of [LINE.replace('START', 'END'), `user text ${LINE}`, LINE.replace('10/7/2026', '2/30/2026'),
    LINE.replace('AM.391', 'AM.3919'), LINE.replace('types=[message]', 'types=[summary]'), LINE.replace('id: answer', 'id: ../../answer')]) {
    assert.deepEqual(parseNativeMessageWrites(line), []);
  }
});

test('same-region shared messages resolve to their private writer; domestic evidence cannot cross regions', (t) => {
  const h = harness(t);
  fs.writeFileSync(h.log(SECOND, { cli: true }), LINE + '\n');
  const owner = h.load();
  assert.deepEqual(owner.resolve(h.file, 'answer', AT), { provider: 'workbuddy', accountRef: SECOND });
  assert.equal(owner.resolve({ ...h.file, provider: 'codebuddycn' }, 'answer', AT), null);
  assert.deepEqual(owner.resolve(h.file, 'another-message', AT), { provider: 'codebuddy', accountRef: '' });
  assert.deepEqual(owner.resolve(h.file, 'answer', AT - 60_000), { provider: 'codebuddy', accountRef: '' },
    'a copied old message is not owned by its importer');
});

test('conflicting contemporaneous writers fail closed and removed accounts no longer provide evidence', (t) => {
  const h = harness(t);
  fs.writeFileSync(h.log(FIRST), LINE + '\n');
  fs.writeFileSync(h.log(SECOND), LINE + '\n');
  assert.deepEqual(h.load().resolve(h.file, 'answer', AT), { provider: 'codebuddy', accountRef: '' });
  h.accounts.delete(SECOND);
  assert.deepEqual(h.load().resolve(h.file, 'answer', AT), { provider: 'codebuddy', accountRef: FIRST });
});

test('the log cache reads only appended bytes, waits for complete lines, and rebuilds on replacement/truncation', (t) => {
  const h = harness(t);
  const log = h.log();
  fs.writeFileSync(log, LINE);
  const before = h.load();
  assert.equal(before.resolve(h.file, 'answer', AT), null);
  const initialBytes = h.bytesRead();
  h.load();
  assert.equal(h.bytesRead(), initialBytes, 'unchanged log contents must not be reread');
  fs.appendFileSync(log, '\n');
  const complete = h.load();
  assert.deepEqual(complete.resolve(h.file, 'answer', AT), { provider: 'codebuddy', accountRef: FIRST });
  assert.notEqual(complete.fingerprint(h.file), before.fingerprint(h.file));
  const bytes = h.bytesRead();
  const next = LINE.replace('id: answer', 'id: second') + '\n';
  fs.appendFileSync(log, next);
  const appended = h.load();
  assert.equal(h.bytesRead() - bytes, Buffer.byteLength(next));
  assert.deepEqual(appended.resolve(h.file, 'second', AT), { provider: 'codebuddy', accountRef: FIRST });
  fs.writeFileSync(log, 'truncated\n');
  assert.equal(h.load().resolve(h.file, 'answer', AT), null);
  fs.writeFileSync(log + '.replacement', next);
  fs.renameSync(log + '.replacement', log);
  const replaced = h.load();
  assert.deepEqual(replaced.resolve(h.file, 'answer', AT), { provider: 'codebuddy', accountRef: '' });
  assert.deepEqual(replaced.resolve(h.file, 'second', AT), { provider: 'codebuddy', accountRef: FIRST });
});

test('host, account, directory, and individual log symlinks never establish account ownership', (t) => {
  const h = harness(t);
  const real = h.log(SECOND);
  fs.writeFileSync(real, LINE + '\n');
  const alias = h.log(FIRST);
  fs.symlinkSync(real, alias);
  assert.deepEqual(h.load().resolve(h.file, 'answer', AT), { provider: 'workbuddy', accountRef: SECOND });
  h.accounts.delete(SECOND);
  assert.equal(h.load().resolve(h.file, 'answer', AT), null);
  fs.rmSync(alias);
  fs.rmdirSync(path.dirname(alias));
  fs.symlinkSync(path.dirname(real), path.dirname(alias), 'dir');
  assert.equal(h.load().resolve(h.file, 'answer', AT), null);
  fs.rmSync(path.dirname(alias));
  const projection = resolveAccountRuntimeDir(h.root, 'codebuddy', FIRST);
  fs.rmSync(projection, { recursive: true });
  fs.symlinkSync(resolveAccountRuntimeDir(h.root, 'workbuddy', SECOND), projection, 'dir');
  assert.equal(h.load().resolve(h.file, 'answer', AT), null);
});
