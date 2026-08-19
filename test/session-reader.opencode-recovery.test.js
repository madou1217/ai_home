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

test('OpenCode reader resolves sessions from the canonical host DB only', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-reader-'));
  const dataRoot = path.join(hostHome, '.local', 'share', 'opencode');
  const canonicalDbPath = path.join(dataRoot, 'opencode.db');
  const orphanedDbPath = path.join(
    dataRoot,
    '.aih-migration-conflicts',
    ACCOUNT_REF,
    'bridge-data',
    'opencode.db'
  );
  const sessionId = 'ses_canonical';

  createOpenCodeDb(canonicalDbPath, {
    id: sessionId,
    directory: '/project/canonical',
    title: 'Canonical session',
    updatedAt: 1000,
    model: 'canonical-model',
    content: 'canonical response'
  });
  createOpenCodeDb(orphanedDbPath, {
    id: sessionId,
    directory: '/project/orphaned',
    title: 'Orphaned session',
    updatedAt: 2000,
    model: 'orphaned-model',
    content: 'orphaned response'
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
  const canonicalProject = projects.find((project) => project.path === '/project/canonical');
  assert.ok(canonicalProject);
  assert.deepEqual(canonicalProject.sessions.map((session) => session.id), [sessionId]);
  assert.equal(projects.some((project) => project.path === '/project/orphaned'), false);

  assert.deepEqual(readSessionMessages('opencode', { sessionId }), [{
    role: 'assistant',
    content: 'canonical response',
    timestamp: new Date(1000).toISOString()
  }]);
  assert.equal(readSessionLastModel('opencode', { sessionId }), 'opencode-go/canonical-model');
  assert.equal(resolveSessionFilePath('opencode', { sessionId }), canonicalDbPath);
});

test('OpenCode catalog rejects canonical realpath escapes', (t) => {
  const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-escape-'));
  const dataRoot = path.join(hostHome, '.local', 'share', 'opencode');
  const outsideRoot = path.join(hostHome, 'outside');
  const outsideCanonicalDb = path.join(outsideRoot, 'canonical.db');
  const sessionId = 'ses_realpath_guard';

  createOpenCodeDb(outsideCanonicalDb, {
    id: sessionId,
    directory: '/project/outside-canonical',
    title: 'Outside canonical',
    updatedAt: 4000,
    model: 'outside-canonical',
    content: 'outside canonical response'
  });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.symlinkSync(outsideCanonicalDb, path.join(dataRoot, 'opencode.db'));

  const { resolveSessionFilePath } = loadSessionReaderForHome(t, hostHome);
  t.after(() => {
    fs.rmSync(hostHome, { recursive: true, force: true });
  });

  assert.equal(resolveSessionFilePath('opencode', { sessionId }), '');
});