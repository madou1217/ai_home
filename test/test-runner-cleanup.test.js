'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildTestEnv,
  createTestTempRoot,
  removeTestTempRoot
} = require('../scripts/run-tests');

test('test runner confines temporary files to one removable owned root', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-runner-fixture-'));
  try {
    const rootDir = createTestTempRoot({ baseDir });
    const nestedFile = path.join(rootDir, 'nested', 'fixture.txt');
    fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
    fs.writeFileSync(nestedFile, 'fixture', 'utf8');

    assert.deepEqual(buildTestEnv(rootDir, { KEEP: 'yes' }), {
      KEEP: 'yes', TMPDIR: rootDir, TMP: rootDir, TEMP: rootDir
    });
    removeTestTempRoot(rootDir);
    assert.equal(fs.existsSync(rootDir), false);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('test runner refuses to delete a directory it does not own', () => {
  const unownedPath = path.join(os.tmpdir(), 'not-owned-by-aih-test-runner');
  assert.throws(() => removeTestTempRoot(unownedPath), /unsafe_test_temp_root/);
});
