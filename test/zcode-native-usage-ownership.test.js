'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { resolveAccountRuntimeDir } = require('../lib/runtime/aih-storage-layout');
const { __private: { readJsonlFromOffset } } = require('../lib/usage/model-usage-scanner');
const { readZcodeNativeUsageOwnership } = require('../lib/usage/zcode-native-usage-ownership');

const AT = 1_790_000_000_000;
const BILL = { usageId: 'usage', sessionId: 'shared', startedAtMs: AT, timestampMs: AT + 100 };

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-zcode-writer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const refs = ['first', 'second'].map((identitySeed, i) => upsertAccountRef(fs, root, {
    provider: 'zcode', cliAccountId: String(i + 1), identitySeed
  }));
  const files = refs.map(ref => path.join(resolveAccountRuntimeDir(root, 'zcode', ref),
    '.aih-runtime', 'zcode-model-usage-owners.jsonl'));
  for (const file of files) fs.mkdirSync(path.dirname(file), { recursive: true });
  const store = {};
  let bytesRead = 0;
  const readerFs = Object.create(fs);
  readerFs.readSync = (...args) => { const bytes = fs.readSync(...args); bytesRead += bytes; return bytes; };
  const load = () => readZcodeNativeUsageOwnership({ fs: readerFs, path, aiHomeDir: root, store, readJsonlFromOffset });
  const line = (i = 0, overrides = {}) => JSON.stringify({ version: 1, accountRef: refs[i], ...BILL, ...overrides });
  return { root, refs, files, load, line, bytesRead: () => bytesRead };
}

test('native ZCode ownership requires matching usage, session and both timestamps; conflicting writers fail closed', (t) => {
  const h = harness(t);
  fs.writeFileSync(h.files[0], h.line() + '\n');
  let index = h.load();
  assert.equal(index.resolve(BILL), h.refs[0]);
  assert.equal(index.resolve({ ...BILL, startedAtMs: AT - 1 }), '');
  assert.equal(index.resolve({ ...BILL, sessionId: 'other' }), null);
  assert.equal(index.resolve({ ...BILL, timestampMs: AT + 101 }), null);
  fs.writeFileSync(h.files[1], h.line(1) + '\n');
  index = h.load();
  assert.equal(index.resolve(BILL), '');
  assert.deepEqual(index.records, []);
});

test('native ZCode ownership incrementally waits for complete lines and rebuilds after truncate or replace', (t) => {
  const h = harness(t);
  fs.writeFileSync(h.files[0], h.line());
  assert.equal(h.load().resolve(BILL), null);
  const initial = h.bytesRead();
  h.load();
  assert.equal(h.bytesRead(), initial);
  fs.appendFileSync(h.files[0], '\n');
  assert.equal(h.load().resolve(BILL), h.refs[0]);
  const before = h.bytesRead();
  const next = h.line(0, { usageId: 'next' }) + '\n';
  fs.appendFileSync(h.files[0], next);
  assert.equal(h.load().resolve({ ...BILL, usageId: 'next' }), h.refs[0]);
  assert.equal(h.bytesRead() - before, Buffer.byteLength(next));
  fs.writeFileSync(h.files[0], 'truncated\n');
  assert.equal(h.load().resolve(BILL), null);
  fs.writeFileSync(h.files[0] + '.replacement', next);
  fs.renameSync(h.files[0] + '.replacement', h.files[0]);
  assert.equal(h.load().resolve(BILL), null);
  assert.equal(h.load().resolve({ ...BILL, usageId: 'next' }), h.refs[0]);
});

test('native ZCode ownership rejects another account identity, invalid metadata, and symlinked evidence', (t) => {
  const h = harness(t);
  const invalid = [h.line(0, { accountRef: h.refs[1] }), h.line(0, { usageId: '../bad' }),
    h.line(0, { startedAtMs: 0 }), h.line(0, { timestampMs: AT - 1 }), h.line(0, { version: 2 })];
  fs.writeFileSync(h.files[0], invalid.join('\n') + '\n');
  assert.deepEqual(h.load().records, []);
  fs.writeFileSync(h.files[0], h.line() + '\n');
  assert.equal(h.load().resolve(BILL), h.refs[0]);
  const copy = path.join(h.root, 'host-log.jsonl');
  fs.writeFileSync(copy, h.line() + '\n');
  fs.unlinkSync(h.files[0]);
  fs.symlinkSync(copy, h.files[0]);
  assert.equal(h.load().resolve(BILL), null, 'a previously cached private log must be evicted after symlink replacement');
  fs.unlinkSync(h.files[0]);
  fs.rmdirSync(path.dirname(h.files[0]));
  const host = path.join(h.root, 'host-index');
  fs.mkdirSync(host);
  fs.writeFileSync(path.join(host, path.basename(h.files[0])), h.line() + '\n');
  fs.symlinkSync(host, path.dirname(h.files[0]), 'dir');
  assert.equal(h.load().resolve(BILL), null);
});
