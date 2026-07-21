const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsExtra = require('fs-extra');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';

function createOpenCodeDb(dbPath, session) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      slug TEXT,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER,
      model TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO session (
      id, project_id, parent_id, slug, directory, title, version,
      time_created, time_updated, time_archived, model
    ) VALUES (?, 'project', NULL, 'session', ?, ?, '1', ?, ?, NULL, ?)
  `).run(
    session.id,
    session.directory,
    session.title,
    session.updatedAt,
    session.updatedAt,
    JSON.stringify({ id: session.model, providerID: 'opencode-go' })
  );
  db.prepare(`
    INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES ('message', ?, ?, ?, ?)
  `).run(
    session.id,
    session.updatedAt,
    session.updatedAt,
    JSON.stringify({ role: 'assistant' })
  );
  db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES ('part', 'message', ?, ?, ?, ?)
  `).run(
    session.id,
    session.updatedAt,
    session.updatedAt,
    JSON.stringify({ type: 'text', text: session.content })
  );
  db.close();
}

function loadSessionReaderForHome(t, hostHome) {
  const previousRealHome = process.env.REAL_HOME;
  process.env.REAL_HOME = hostHome;
  delete require.cache[require.resolve('../lib/sessions/session-reader')];
  const reader = require('../lib/sessions/session-reader');
  t.after(() => {
    if (previousRealHome === undefined) delete process.env.REAL_HOME;
    else process.env.REAL_HOME = previousRealHome;
    delete require.cache[require.resolve('../lib/sessions/session-reader')];
  });
  return reader;
}

test('OpenCode recovery DB remains readable and wins duplicate sessions by update time', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-recovery-reader-'));
  const dataRoot = path.join(hostHome, '.local', 'share', 'opencode');
  const canonicalDbPath = path.join(dataRoot, 'opencode.db');
  const recoveryDbPath = path.join(
    dataRoot,
    '.aih-migration-conflicts',
    ACCOUNT_REF,
    'bridge-data',
    'opencode.db'
  );
  const ignoredDbPath = path.join(
    dataRoot,
    '.aih-migration-conflicts',
    ACCOUNT_REF,
    'unmanaged-source',
    'opencode.db'
  );
  const sessionId = 'ses_recovered';

  createOpenCodeDb(canonicalDbPath, {
    id: sessionId,
    directory: '/project/canonical',
    title: 'Canonical stale session',
    updatedAt: 1000,
    model: 'canonical-model',
    content: 'canonical stale response'
  });
  createOpenCodeDb(recoveryDbPath, {
    id: sessionId,
    directory: '/project/recovered',
    title: 'Recovered current session',
    updatedAt: 2000,
    model: 'recovery-model',
    content: 'recovered current response'
  });
  createOpenCodeDb(ignoredDbPath, {
    id: sessionId,
    directory: '/project/ignored',
    title: 'Unmanaged newest session',
    updatedAt: 3000,
    model: 'ignored-model',
    content: 'unmanaged response'
  });

  const {
    readProjectsFromHostByProviders,
    readSessionLastModel,
    readSessionMessages,
    resolveSessionFilePath
  } = loadSessionReaderForHome(t, hostHome);

  t.after(() => {
    fs.rmSync(hostHome, { recursive: true, force: true });
  });

  const projects = readProjectsFromHostByProviders(['opencode']);
  const recoveredProject = projects.find((project) => project.path === '/project/recovered');
  assert.ok(recoveredProject);
  assert.deepEqual(recoveredProject.sessions.map((session) => session.id), [sessionId]);
  assert.equal(projects.some((project) => project.path === '/project/canonical'), false);
  assert.equal(projects.some((project) => project.path === '/project/ignored'), false);

  assert.deepEqual(readSessionMessages('opencode', { sessionId }), [{
    role: 'assistant',
    content: 'recovered current response',
    timestamp: new Date(2000).toISOString()
  }]);
  assert.equal(readSessionLastModel('opencode', { sessionId }), 'opencode-go/recovery-model');
  assert.equal(resolveSessionFilePath('opencode', { sessionId }), recoveryDbPath);
});

test('OpenCode catalog rejects canonical and recovery realpath escapes', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-recovery-escape-'));
  const dataRoot = path.join(hostHome, '.local', 'share', 'opencode');
  const outsideRoot = path.join(hostHome, 'outside');
  const outsideCanonicalDb = path.join(outsideRoot, 'canonical.db');
  const escapedRecoveryDir = path.join(outsideRoot, 'recovery');
  const escapedRecoveryDb = path.join(escapedRecoveryDir, 'opencode.db');
  const escapedSourceRoot = path.join(
    dataRoot,
    '.aih-migration-conflicts',
    'acct_ffffffffffffffffffff',
    'account-data'
  );
  const recoverySourceRoot = path.join(
    dataRoot,
    '.aih-migration-conflicts',
    ACCOUNT_REF,
    'bridge-data'
  );
  const recoveryDbPath = path.join(recoverySourceRoot, 'opencode.db');
  const sessionId = 'ses_realpath_guard';

  createOpenCodeDb(outsideCanonicalDb, {
    id: sessionId,
    directory: '/project/outside-canonical',
    title: 'Outside canonical',
    updatedAt: 4000,
    model: 'outside-canonical',
    content: 'outside canonical response'
  });
  createOpenCodeDb(escapedRecoveryDb, {
    id: sessionId,
    directory: '/project/outside-recovery',
    title: 'Outside recovery',
    updatedAt: 3000,
    model: 'outside-recovery',
    content: 'outside recovery response'
  });
  createOpenCodeDb(recoveryDbPath, {
    id: sessionId,
    directory: '/project/inside-recovery',
    title: 'Inside recovery',
    updatedAt: 2000,
    model: 'inside-recovery',
    content: 'inside recovery response'
  });
  fs.symlinkSync(outsideCanonicalDb, path.join(dataRoot, 'opencode.db'));
  fs.symlinkSync(escapedRecoveryDir, path.join(recoverySourceRoot, 'escaped'), 'dir');
  fs.mkdirSync(path.dirname(escapedSourceRoot), { recursive: true });
  fs.symlinkSync(escapedRecoveryDir, escapedSourceRoot, 'dir');

  const { resolveSessionFilePath } = loadSessionReaderForHome(t, hostHome);
  const originalReadDirSync = fsExtra.readdirSync;
  fsExtra.readdirSync = (dirPath, options) => {
    if (dirPath === escapedSourceRoot) {
      const error = new Error('symlinked recovery source must not be traversed');
      error.code = 'EACCES';
      throw error;
    }
    return originalReadDirSync(dirPath, options);
  };
  t.after(() => {
    fsExtra.readdirSync = originalReadDirSync;
    fs.rmSync(hostHome, { recursive: true, force: true });
  });

  assert.equal(resolveSessionFilePath('opencode', { sessionId }), recoveryDbPath);
});

test('OpenCode recovery catalog surfaces non-missing directory read failures', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-recovery-error-'));
  const dataRoot = path.join(hostHome, '.local', 'share', 'opencode');
  const conflictRoot = path.join(dataRoot, '.aih-migration-conflicts');
  const canonicalDbPath = path.join(dataRoot, 'opencode.db');
  const sessionId = 'ses_scan_error';

  createOpenCodeDb(canonicalDbPath, {
    id: sessionId,
    directory: '/project/canonical',
    title: 'Canonical session',
    updatedAt: 1000,
    model: 'canonical-model',
    content: 'canonical response'
  });
  fs.mkdirSync(conflictRoot, { recursive: true });

  const { resolveSessionFilePath } = loadSessionReaderForHome(t, hostHome);
  const originalReadDirSync = fsExtra.readdirSync;
  fsExtra.readdirSync = (dirPath, options) => {
    if (dirPath === conflictRoot) {
      const error = new Error('recovery catalog unavailable');
      error.code = 'EACCES';
      throw error;
    }
    return originalReadDirSync(dirPath, options);
  };
  t.after(() => {
    fsExtra.readdirSync = originalReadDirSync;
    fs.rmSync(hostHome, { recursive: true, force: true });
  });

  assert.throws(
    () => resolveSessionFilePath('opencode', { sessionId }),
    (error) => error && error.code === 'EACCES'
  );
});
