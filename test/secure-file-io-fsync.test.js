'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  atomicWritePrivateFile,
  fsyncDirectory,
  fsyncFile
} = require('../lib/cli/services/toolkit/proxy-pool/secure-file-io');

function createTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-secure-file-io-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fsyncError(code) {
  const error = new Error(`${code}: operation not permitted, fsync`);
  error.code = code;
  return error;
}

// Real fs, but every fsync fails with `code` (or succeeds when code is null).
// `openFlags` records the flags each openSync call used.
function createFs(options = {}) {
  const openFlags = [];
  return {
    openFlags,
    fs: new Proxy(fs, {
      get(target, prop) {
        if (prop === 'fsyncSync') {
          return () => {
            if (options.fsyncCode) throw fsyncError(options.fsyncCode);
          };
        }
        if (prop === 'openSync') {
          return (...args) => {
            openFlags.push(String(args[1]));
            return target.openSync(...args);
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    })
  };
}

test('atomicWritePrivateFile writes the file and opens a writable handle for fsync', (t) => {
  const dir = createTempDir(t);
  const { fs: fsImpl, openFlags } = createFs();
  const target = path.join(dir, 'state.json');

  atomicWritePrivateFile(fsImpl, path, target, '{"ok":true}\n');

  assert.equal(fs.readFileSync(target, 'utf8'), '{"ok":true}\n');
  assert.ok(
    openFlags.includes('r+'),
    `expected a writable handle for the file fsync, saw: ${JSON.stringify(openFlags)}`
  );
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')).length, 0);
});

// Regression: on Windows, flushing a read-only handle fails with EPERM. That used
// to abort the whole atomic write, which made ZCode egress state.json impossible
// to create and logged "ZCode egress restore: 1 endpoint(s) failed" on every start.
test('atomicWritePrivateFile tolerates a read-only-handle fsync failure (Windows EPERM)', (t) => {
  const dir = createTempDir(t);
  const target = path.join(dir, 'state.json');

  for (const code of ['EPERM', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EBADF']) {
    const { fs: fsImpl } = createFs({ fsyncCode: code });
    atomicWritePrivateFile(fsImpl, path, target, `{"code":"${code}"}\n`);
    assert.equal(fs.readFileSync(target, 'utf8'), `{"code":"${code}"}\n`);
  }
});

test('atomicWritePrivateFile still surfaces real fsync failures', (t) => {
  const dir = createTempDir(t);
  const { fs: fsImpl } = createFs({ fsyncCode: 'EIO' });
  const target = path.join(dir, 'state.json');

  assert.throws(
    () => atomicWritePrivateFile(fsImpl, path, target, '{}\n'),
    (error) => error.code === 'EIO'
  );
  // The temp file must not be left behind when the write aborts.
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')).length, 0);
});

test('fsyncFile is a no-op when the fs implementation cannot fsync', (t) => {
  const dir = createTempDir(t);
  const target = path.join(dir, 'plain.txt');
  fs.writeFileSync(target, 'x');

  assert.doesNotThrow(() => fsyncFile({ openSync: fs.openSync }, target));
  assert.doesNotThrow(() => fsyncFile({ fsyncSync: fs.fsyncSync }, target));
});

test('fsyncDirectory tolerates platform rejections of directory fsync', (t) => {
  const dir = createTempDir(t);

  for (const code of ['EPERM', 'EINVAL', 'EISDIR']) {
    const { fs: fsImpl } = createFs({ fsyncCode: code });
    assert.doesNotThrow(() => fsyncDirectory(fsImpl, dir));
  }

  const { fs: failing } = createFs({ fsyncCode: 'EIO' });
  assert.throws(() => fsyncDirectory(failing, dir), (error) => error.code === 'EIO');
});
