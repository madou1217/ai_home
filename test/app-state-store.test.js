'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getAppStateDbPath,
  openAppStateDatabase
} = require('../lib/server/app-state-store');

test('app state database files are private on POSIX hosts', (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-app-state-mode-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const db = openAppStateDatabase(fs, aiHomeDir);
  db.prepare('INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)')
    .run('mode-check', '{}', Date.now());

  if (process.platform !== 'win32') {
    const paths = [
      getAppStateDbPath(aiHomeDir),
      `${getAppStateDbPath(aiHomeDir)}-wal`,
      `${getAppStateDbPath(aiHomeDir)}-shm`
    ].filter((filePath) => fs.existsSync(filePath));
    paths.forEach((filePath) => {
      assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, filePath);
    });
  }
  db.close();
});
