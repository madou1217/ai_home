'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MARKER_FILE,
  createTransientAuthProjection,
  createTransientAuthProjectionLease,
  isTransientAuthProjection,
  removeTransientAuthProjection
} = require('../lib/runtime/transient-auth-projection');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';

test('transient auth projection is marker-bound and removed by exact identity', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-transient-auth-test-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const runtimeDir = createTransientAuthProjection(fs, 'codex', ACCOUNT_REF, {
    path,
    tempRoot
  });

  assert.equal(isTransientAuthProjection(fs, runtimeDir, 'codex', ACCOUNT_REF, {
    path,
    tempRoot
  }), true);
  assert.equal(isTransientAuthProjection(fs, runtimeDir, 'codex', 'acct_aaaaaaaaaaaaaaaaaaaa', {
    path,
    tempRoot
  }), false);
  assert.equal(fs.existsSync(path.join(runtimeDir, MARKER_FILE)), true);
  assert.equal(removeTransientAuthProjection(fs, runtimeDir, 'codex', ACCOUNT_REF, {
    path,
    tempRoot
  }), true);
  assert.equal(fs.existsSync(runtimeDir), false);
});

test('transient auth cleanup rejects an unmarked directory', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-transient-auth-reject-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const unmarkedDir = fs.mkdtempSync(path.join(tempRoot, `aih-auth-codex-${ACCOUNT_REF}-`));
  fs.writeFileSync(path.join(unmarkedDir, 'keep.txt'), 'keep', 'utf8');

  assert.throws(
    () => removeTransientAuthProjection(fs, unmarkedDir, 'codex', ACCOUNT_REF, {
      path,
      tempRoot
    }),
    (error) => error && error.code === 'transient_auth_projection_cleanup_rejected'
  );
  assert.equal(fs.readFileSync(path.join(unmarkedDir, 'keep.txt'), 'utf8'), 'keep');
});

test('transient auth projection lease release is idempotent', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-transient-auth-lease-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const lease = createTransientAuthProjectionLease(fs, 'codex', ACCOUNT_REF, {
    path,
    tempRoot
  });

  assert.equal(lease.active, true);
  assert.equal(fs.existsSync(lease.runtimeDir), true);
  assert.equal(lease.release(), true);
  assert.equal(lease.active, false);
  assert.equal(fs.existsSync(lease.runtimeDir), false);
  assert.equal(lease.release(), false);
});
