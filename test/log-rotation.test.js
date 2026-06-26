const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { rotateIfOversized, sweepAihLogs, resolveMaxBytes, DEFAULT_MAX_BYTES } = require('../lib/server/log-rotation');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-logrot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('resolveMaxBytes: env override or default', () => {
  assert.equal(resolveMaxBytes({ AIH_LOG_MAX_BYTES: '1048576' }), 1048576);
  assert.equal(resolveMaxBytes({}), DEFAULT_MAX_BYTES);
  assert.equal(resolveMaxBytes({ AIH_LOG_MAX_BYTES: 'nope' }), DEFAULT_MAX_BYTES);
  assert.equal(resolveMaxBytes({ AIH_LOG_MAX_BYTES: '-5' }), DEFAULT_MAX_BYTES);
});

test('rotateIfOversized: rotates past the cap, keeps one generation', (t) => {
  const dir = tmpDir(t);
  const f = path.join(dir, 'server.log');
  fs.writeFileSync(f, 'x'.repeat(100));

  assert.equal(rotateIfOversized(fs, path, f, 1000), false, 'under cap → no rotate');

  fs.writeFileSync(f, 'y'.repeat(2000));
  assert.equal(rotateIfOversized(fs, path, f, 1000), true, 'over cap → rotate');
  assert.equal(fs.existsSync(f), false, 'current file moved aside');
  assert.equal(fs.readFileSync(`${f}.1`, 'utf8').length, 2000);

  // a fresh write starts a new file; next rotation overwrites the single .1
  fs.writeFileSync(f, 'z'.repeat(2000));
  assert.equal(rotateIfOversized(fs, path, f, 1000), true);
  assert.equal(fs.readFileSync(`${f}.1`, 'utf8')[0], 'z', 'only one generation kept');
});

test('rotateIfOversized: missing file is a safe no-op', (t) => {
  const dir = tmpDir(t);
  assert.equal(rotateIfOversized(fs, path, path.join(dir, 'nope.log'), 10), false);
});

test('sweepAihLogs: rotates oversized *.log/*.jsonl only, skips others and .1', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'server.log'), 'a'.repeat(2000));
  fs.writeFileSync(path.join(dir, 'codex-mobile-trace.jsonl'), 'b'.repeat(2000));
  fs.writeFileSync(path.join(dir, 'small.log'), 'c'.repeat(10));
  fs.writeFileSync(path.join(dir, 'account_state.db'), 'd'.repeat(5000)); // not a log
  fs.writeFileSync(path.join(dir, 'server.log.1'), 'e'.repeat(5000)); // already rotated

  const rotated = sweepAihLogs(fs, path, dir, { maxBytes: 1000 });
  assert.equal(rotated, 2, 'only the two oversized log/jsonl files rotate');
  assert.ok(fs.existsSync(path.join(dir, 'server.log.1')));
  assert.ok(fs.existsSync(path.join(dir, 'codex-mobile-trace.jsonl.1')));
  assert.ok(fs.existsSync(path.join(dir, 'small.log')), 'under-cap log untouched');
  assert.ok(fs.existsSync(path.join(dir, 'account_state.db')), 'non-log untouched');
});
