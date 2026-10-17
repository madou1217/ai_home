'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LAUNCH_CONTEXT_ENV,
  writeLaunchContext,
  readLaunchContext,
  launchContextValue
} = require('../lib/runtime/launch-context');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aih-launch-context-'));
}

test('writeLaunchContext writes a 0600 json file and reads it back', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const file = writeLaunchContext({ runId: 'r1', approvalUrl: 'http://127.0.0.1:9527/a' }, { root, name: 'approval-r1' });
  assert.equal(file, path.join(root, 'run', 'launch-context', 'approval-r1.json'));
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);

  const env = { [LAUNCH_CONTEXT_ENV]: file };
  assert.equal(readLaunchContext(env).runId, 'r1');
  assert.equal(launchContextValue(env, 'approvalUrl'), 'http://127.0.0.1:9527/a');
  assert.equal(launchContextValue(env, 'missing', 'fallback'), 'fallback');
});

test('readLaunchContext fails closed when the file is absent or corrupt', (t) => {
  const root = mkTmpDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(readLaunchContext({}), {});
  assert.deepEqual(readLaunchContext({ [LAUNCH_CONTEXT_ENV]: path.join(root, 'nope.json') }), {});

  const corrupt = path.join(root, 'corrupt.json');
  fs.writeFileSync(corrupt, '{not json');
  assert.deepEqual(readLaunchContext({ [LAUNCH_CONTEXT_ENV]: corrupt }), {});
});
