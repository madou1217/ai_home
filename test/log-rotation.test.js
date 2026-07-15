const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  sweepAihLogs,
  trimFileToRecentBytes,
  resolveMaxAgeMs,
  resolveMaxBytes,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_BYTES
} = require('../lib/server/log-rotation');
const { appendBoundedJsonLine } = require('../lib/server/bounded-log-writer');

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

test('resolveMaxAgeMs: env override or default', () => {
  assert.equal(resolveMaxAgeMs({ AIH_LOG_MAX_AGE_DAYS: '2' }), 2 * 24 * 60 * 60 * 1000);
  assert.equal(resolveMaxAgeMs({}), DEFAULT_MAX_AGE_MS);
  assert.equal(resolveMaxAgeMs({ AIH_LOG_MAX_AGE_DAYS: 'nope' }), DEFAULT_MAX_AGE_MS);
});

test('appendBoundedJsonLine rejects unserializable payloads without throwing', (t) => {
  const dir = tmpDir(t);
  const circular = {};
  circular.self = circular;

  assert.equal(appendBoundedJsonLine(fs, path.join(dir, 'audit.jsonl'), circular), false);
  assert.equal(fs.existsSync(path.join(dir, 'audit.jsonl')), false);
});

test('appendBoundedJsonLine trims active logs in place during sustained writes', (t) => {
  const dir = tmpDir(t);
  const filePath = path.join(dir, 'server.log');
  for (let index = 0; index < 65; index += 1) {
    assert.equal(appendBoundedJsonLine(fs, filePath, { index, payload: 'x'.repeat(32) }, {
      path,
      maxBytes: 128
    }), true);
  }

  assert.equal(fs.existsSync(`${filePath}.1`), false);
  assert.ok(fs.statSync(filePath).size <= 128);
  const currentEntries = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(currentEntries.at(-1).index, 64);
});

test('appendBoundedJsonLine rejects one entry larger than the configured cap', (t) => {
  const dir = tmpDir(t);
  const filePath = path.join(dir, 'diagnostic.jsonl');

  assert.equal(appendBoundedJsonLine(fs, filePath, { payload: 'x'.repeat(256) }, {
    path,
    maxBytes: 128
  }), false);
  assert.equal(fs.existsSync(filePath), false);
});

test('appendBoundedJsonLine hardens an existing log before appending', (t) => {
  const dir = tmpDir(t);
  const filePath = path.join(dir, 'audit.jsonl');
  fs.writeFileSync(filePath, '{"existing":true}\n', { mode: 0o644 });

  assert.equal(appendBoundedJsonLine(fs, filePath, { appended: true }), true);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
});

test('trimFileToRecentBytes retains recent complete log lines', (t) => {
  const dir = tmpDir(t);
  const filePath = path.join(dir, 'events.jsonl');
  const lines = Array.from({ length: 20 }, (_, index) => JSON.stringify({ index }));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);

  assert.equal(trimFileToRecentBytes(fs, filePath, 80), true);
  const retained = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(retained.at(-1).index, 19);
  assert.ok(fs.statSync(filePath).size <= 80);
});

test('sweepAihLogs trims files in place, expires old logs, and skips non-logs', (t) => {
  const dir = tmpDir(t);
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'server.log'), 'a'.repeat(2000));
  fs.writeFileSync(path.join(dir, 'codex-mobile-trace.jsonl'), 'b'.repeat(2000));
  fs.writeFileSync(path.join(dir, 'small.log'), 'c'.repeat(10));
  fs.writeFileSync(path.join(dir, 'account_state.db'), 'd'.repeat(5000)); // not a log
  fs.writeFileSync(path.join(dir, 'small.log.1'), 'e'.repeat(5000));
  fs.writeFileSync(path.join(dir, 'expired.log'), 'old');
  fs.utimesSync(path.join(dir, 'expired.log'), new Date(now - 5000), new Date(now - 5000));

  const changed = sweepAihLogs(fs, path, dir, { maxBytes: 1000, maxAgeMs: 1000, now });
  assert.equal(changed, 4, 'three oversized logs are trimmed and one expired log is removed');
  assert.ok(fs.statSync(path.join(dir, 'server.log')).size <= 1000);
  assert.ok(fs.statSync(path.join(dir, 'codex-mobile-trace.jsonl')).size <= 1000);
  assert.ok(fs.statSync(path.join(dir, 'small.log.1')).size <= 1000);
  assert.ok(fs.existsSync(path.join(dir, 'small.log')), 'under-cap log untouched');
  assert.equal(fs.existsSync(path.join(dir, 'expired.log')), false);
  assert.ok(fs.existsSync(path.join(dir, 'account_state.db')), 'non-log untouched');
  assert.equal(fs.statSync(path.join(dir, 'small.log')).mode & 0o777, 0o600);
});
