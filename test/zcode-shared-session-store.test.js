'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureZcodeSharedSessionState,
  ZCODE_SHARED_DIR_ENTRIES,
  ZCODE_TASKS_INDEX_FILE,
  ZCODE_TASKS_INDEX_SIDECARS
} = require('../lib/cli/services/ai-cli/launch-profile/zcode-shared-session-store');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-shared-test-'));
  const sandboxDir = path.join(root, 'sandbox');
  const hostHomeDir = path.join(root, 'host');
  fs.mkdirSync(path.join(sandboxDir, '.zcode', 'v2'), { recursive: true });
  fs.mkdirSync(path.join(hostHomeDir, '.zcode', 'v2'), { recursive: true });
  return { root, sandboxDir, hostHomeDir };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch (_error) {
    return false;
  }
}

test('fresh projection: all session entries become links into the host store', () => {
  const { root, sandboxDir, hostHomeDir } = makeTree();
  try {
    const summary = ensureZcodeSharedSessionState({ sandboxDir, hostHomeDir });
    assert.deepEqual(summary.errors, []);
    assert.equal(summary.discarded, 0);
    for (const seg of ZCODE_SHARED_DIR_ENTRIES) {
      const link = path.join(sandboxDir, '.zcode', ...seg);
      assert.ok(isLink(link), `${seg.join('/')} should be a link`);
      assert.ok(fs.existsSync(path.join(hostHomeDir, '.zcode', ...seg)), 'shared dir exists');
    }
    const dbLink = path.join(sandboxDir, '.zcode', ...ZCODE_TASKS_INDEX_FILE);
    assert.ok(isLink(dbLink));
    assert.ok(fs.existsSync(path.join(hostHomeDir, '.zcode', ...ZCODE_TASKS_INDEX_FILE)));
    // wal/shm links are created dangling on purpose (SQLite creates the target
    // through the link on first write).
    for (const seg of ZCODE_TASKS_INDEX_SIDECARS) {
      assert.ok(isLink(path.join(sandboxDir, '.zcode', ...seg)), `${seg.join('/')} link`);
    }
    // identity files are never linked
    fs.writeFileSync(path.join(sandboxDir, '.zcode', 'v2', 'credentials.json'), '{}');
    const again = ensureZcodeSharedSessionState({ sandboxDir, hostHomeDir });
    assert.deepEqual(again.errors, []);
    assert.ok(!isLink(path.join(sandboxDir, '.zcode', 'v2', 'credentials.json')));
  } finally {
    cleanup(root);
  }
});

test('projection residue is deleted in place, never copied or moved anywhere', () => {
  const { root, sandboxDir, hostHomeDir } = makeTree();
  try {
    const projDb = path.join(sandboxDir, '.zcode', 'v2', 'tasks-index.sqlite');
    fs.writeFileSync(projDb, 'projection-db');
    fs.writeFileSync(projDb + '-wal', 'projection-wal');
    const projCli = path.join(sandboxDir, '.zcode', 'cli');
    fs.mkdirSync(projCli, { recursive: true });
    fs.writeFileSync(path.join(projCli, 'history.txt'), 'cli-history');
    fs.writeFileSync(path.join(hostHomeDir, '.zcode', 'v2', 'tasks-index.sqlite'), 'shared-db');

    const summary = ensureZcodeSharedSessionState({ sandboxDir, hostHomeDir });
    assert.deepEqual(summary.errors, []);
    assert.equal(summary.discarded, 3);

    // residue is gone, not relocated: nothing may exist outside the two roots
    assert.ok(!fs.existsSync(path.join(hostHomeDir, '.zcode', '.aih-migration-conflicts')));
    assert.ok(isLink(projDb));
    assert.equal(fs.readFileSync(projDb, 'utf8'), 'shared-db');
    assert.ok(isLink(projCli));
    assert.deepEqual(fs.readdirSync(path.join(hostHomeDir, '.zcode', 'cli')), []);
    // shared store content is exactly what the host already had
    assert.equal(fs.readFileSync(path.join(hostHomeDir, '.zcode', 'v2', 'tasks-index.sqlite'), 'utf8'), 'shared-db');
  } finally {
    cleanup(root);
  }
});

test('existing correct links are left untouched (idempotent)', () => {
  const { root, sandboxDir, hostHomeDir } = makeTree();
  try {
    ensureZcodeSharedSessionState({ sandboxDir, hostHomeDir });
    fs.writeFileSync(path.join(hostHomeDir, '.zcode', 'v2', 'tasks-index.sqlite'), 'shared-db');
    const before = ensureZcodeSharedSessionState({ sandboxDir, hostHomeDir });
    assert.deepEqual(before.errors, []);
    assert.equal(before.discarded, 0);
    assert.equal(fs.readFileSync(path.join(sandboxDir, '.zcode', 'v2', 'tasks-index.sqlite'), 'utf8'), 'shared-db');
  } finally {
    cleanup(root);
  }
});

test('stale wal symlink deleted by SQLite clean close is repaired on next launch', () => {
  const { root, sandboxDir, hostHomeDir } = makeTree();
  try {
    ensureZcodeSharedSessionState({ sandboxDir, hostHomeDir });
    const walLink = path.join(sandboxDir, '.zcode', 'v2', 'tasks-index.sqlite-wal');
    assert.ok(isLink(walLink));
    fs.unlinkSync(walLink); // simulate SQLite deleting the wal via the link path
    const repaired = ensureZcodeSharedSessionState({ sandboxDir, hostHomeDir });
    assert.deepEqual(repaired.errors, []);
    assert.ok(isLink(walLink));
  } finally {
    cleanup(root);
  }
});

test('fail-closed when sandbox and host home are the same directory', () => {
  const { root, sandboxDir } = makeTree();
  try {
    const summary = ensureZcodeSharedSessionState({ sandboxDir, hostHomeDir: sandboxDir });
    assert.equal(summary.linked, 0);
    assert.equal(summary.discarded, 0);
    assert.ok(!isLink(path.join(sandboxDir, '.zcode', 'v2', 'tasks-index.sqlite')));
  } finally {
    cleanup(root);
  }
});
