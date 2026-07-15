const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  alignCodexSessionProviders,
  isLegacyAihProvider,
  readSessionMetaProvider
} = require('../lib/cli/services/ai-cli/codex-session-provider-alignment');

function getDatabaseSync() {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    return null;
  }
}

function writeStateDb(DatabaseSync, dbPath, providers) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO threads (id, model_provider) VALUES (?, ?)');
  providers.forEach((provider, index) => insert.run(`thread-${index}`, provider));
  db.close();
}

function readProviders(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const providers = db.prepare('SELECT model_provider FROM threads ORDER BY id').all()
    .map((row) => row.model_provider);
  db.close();
  return providers;
}

function writeSession(filePath, provider, bodyLine) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: path.basename(filePath, '.jsonl'), model_provider: provider }
    }),
    bodyLine,
    ''
  ].join('\n'), 'utf8');
}

test('legacy AIH provider matching excludes the canonical and non-AIH providers', () => {
  assert.equal(isLegacyAihProvider('aih'), true);
  assert.equal(isLegacyAihProvider('aih_1'), true);
  assert.equal(isLegacyAihProvider('aih__aih-server'), true);
  assert.equal(isLegacyAihProvider('aih_server'), false);
  assert.equal(isLegacyAihProvider('openai'), false);
  assert.equal(isLegacyAihProvider('yesboss'), false);
});

test('Codex session provider alignment rejects an empty Codex home', () => {
  assert.throws(
    () => alignCodexSessionProviders('', { fs, path, DatabaseSync: class {} }),
    /codex_home_required/
  );
});

test('Codex session provider alignment dry-runs then updates DBs and session metadata idempotently', (t) => {
  const DatabaseSync = getDatabaseSync();
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-provider-align-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, '.codex');
  const currentDb = path.join(codexHome, 'state_5.sqlite');
  const legacyDb = path.join(codexHome, 'sqlite', 'state_5.sqlite');
  writeStateDb(DatabaseSync, currentDb, ['aih_1', 'openai', 'aih_server']);
  writeStateDb(DatabaseSync, legacyDb, ['aih', 'custom']);

  const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '11');
  const legacySession = path.join(sessionDir, 'legacy.jsonl');
  const currentSession = path.join(sessionDir, 'current.jsonl');
  const bodyLine = JSON.stringify({
    type: 'event_msg',
    payload: { type: 'user_message', message: 'literal model_provider aih_1 must stay untouched' }
  });
  writeSession(legacySession, 'aih_10', bodyLine);
  writeSession(currentSession, 'openai', bodyLine);

  const dryRun = alignCodexSessionProviders(codexHome, {
    fs,
    path,
    DatabaseSync
  });
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.databaseRowsMatched, 2);
  assert.equal(dryRun.databaseRowsChanged, 0);
  assert.equal(dryRun.rolloutFilesMatched, 1);
  assert.equal(dryRun.rolloutFilesChanged, 0);
  assert.deepEqual(readProviders(DatabaseSync, currentDb), ['aih_1', 'openai', 'aih_server']);
  assert.equal(readSessionMetaProvider(fs, legacySession).provider, 'aih_10');

  const applied = alignCodexSessionProviders(codexHome, {
    fs,
    path,
    DatabaseSync,
    apply: true
  });
  assert.equal(applied.databaseRowsChanged, 2);
  assert.equal(applied.rolloutFilesChanged, 1);
  assert.deepEqual(readProviders(DatabaseSync, currentDb), ['aih_server', 'openai', 'aih_server']);
  assert.deepEqual(readProviders(DatabaseSync, legacyDb), ['aih_server', 'custom']);
  assert.equal(readSessionMetaProvider(fs, legacySession).provider, 'aih_server');
  assert.equal(fs.readFileSync(legacySession, 'utf8').split('\n')[1], bodyLine);
  assert.equal(readSessionMetaProvider(fs, currentSession).provider, 'openai');

  const repeated = alignCodexSessionProviders(codexHome, {
    fs,
    path,
    DatabaseSync,
    apply: true
  });
  assert.equal(repeated.databaseRowsMatched, 0);
  assert.equal(repeated.databaseRowsChanged, 0);
  assert.equal(repeated.rolloutFilesMatched, 0);
  assert.equal(repeated.rolloutFilesChanged, 0);
});
