'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAINTENANCE_RETENTION_MS,
  pruneExpiredMaintenanceDirectories
} = require('../lib/runtime/account-maintenance-retention');

const DAY = 24 * 60 * 60 * 1000;
const id = (n) => `oauth-rekey-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function setup(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-maintenance-retention-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const root = path.join(aiHomeDir, 'migration');
  fs.mkdirSync(root);
  const now = Date.now();
  const add = (name, state, ageMs) => {
    const directory = path.join(root, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'database.sqlite'), 'snapshot');
    const journal = path.join(directory, 'journal.json');
    fs.writeFileSync(journal, JSON.stringify({ state }));
    const at = new Date(now - ageMs);
    fs.utimesSync(journal, at, at);
    return directory;
  };
  return { aiHomeDir, root, now, add };
}

test('terminal maintenance directories are removed once the undo window has passed', (t) => {
  const f = setup(t);
  f.add(id(1), 'completed', MAINTENANCE_RETENTION_MS + DAY);
  f.add(id(2), 'rolled_back', MAINTENANCE_RETENTION_MS + DAY);
  f.add(id(3), 'completed', DAY);

  const result = pruneExpiredMaintenanceDirectories(fs, f.aiHomeDir, { now: () => f.now });

  assert.deepEqual(result.removed.sort(), [id(1), id(2)]);
  assert.deepEqual(fs.readdirSync(f.root), [id(3)], 'a completed migration stays undoable inside the window');
});

test('unfinished, unreadable and foreign entries are never removed', (t) => {
  const f = setup(t);
  f.add(id(4), 'applying', 30 * DAY);
  f.add(id(5), 'rollback_requested', 30 * DAY);
  const broken = path.join(f.root, id(6));
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'journal.json'), '{not json');
  fs.writeFileSync(path.join(f.root, 'go-account-ledger.json'), '{}');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-maintenance-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'journal.json'), JSON.stringify({ state: 'completed' }));
  fs.utimesSync(path.join(outside, 'journal.json'), new Date(0), new Date(0));
  fs.symlinkSync(outside, path.join(f.root, id(7)));

  const result = pruneExpiredMaintenanceDirectories(fs, f.aiHomeDir, { now: () => f.now });

  assert.deepEqual(result.removed, []);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['go-account-ledger.json', id(4), id(5), id(6), id(7)].sort());
  assert.equal(fs.existsSync(path.join(outside, 'journal.json')), true, 'a symlink is never followed');
});

test('a missing migration directory is a no-op', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-maintenance-retention-empty-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  assert.deepEqual(pruneExpiredMaintenanceDirectories(fs, aiHomeDir), { removed: [] });
});
