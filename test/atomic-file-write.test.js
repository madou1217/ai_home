'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { writeFileAtomic } = require('../lib/runtime/atomic-file-write');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-atomic-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the target is replaced and no temporary file is left behind', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, 'old');

  writeFileAtomic(fs, file, 'new', { mode: 0o600 });

  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('a failed rename removes the temporary file and keeps the old content', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, 'old');
  const failingFs = { ...fs, renameSync() { throw new Error('rename_failed'); } };

  assert.throws(() => writeFileAtomic(failingFs, file, 'new'), /rename_failed/);

  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('a failed write leaves nothing behind', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'state.json');
  const failingFs = {
    ...fs,
    writeFileSync(target, data, options) {
      fs.writeFileSync(target, String(data).slice(0, 1), options);
      throw new Error('disk_full');
    }
  };

  assert.throws(() => writeFileAtomic(failingFs, file, 'new'), /disk_full/);

  assert.deepEqual(fs.readdirSync(dir), []);
});
